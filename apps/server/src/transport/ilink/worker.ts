import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppConfig, UserRole } from "../../config/types.js";
import { ParsedCommand, parseBuiltInCommand } from "../../commands/index.js";
import {
  CodexBackend,
  CodexProgressEvent,
  CodexResponseMode,
  createCodexBackend,
} from "../../codex/index.js";
import {
  assertFileAllowedForWechatCommand,
  inferMimeType,
  sendLocalFileToSession,
} from "../../files/index.js";
import {
  errorToRedactedMessage,
  filterFamilyOutput,
} from "../../policy/index.js";
import { resolveRole } from "../../router/index.js";
import {
  createNextSession,
  buildPromptContext,
  ensureActiveSession,
  formatBeijingTime,
  shouldRotateSession,
} from "../../sessions/index.js";
import {
  AppDatabase,
  SessionRecord,
  WechatAccountRecord,
} from "../../storage/index.js";
import {
  downloadEncryptedMediaFromCdn,
  sendTextMessage,
} from "./media.js";
import { ILinkApiClient } from "./api-client.js";
import {
  normalizeInboundWechatMessages,
  NormalizedInboundAttachment,
} from "./inbound.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface SessionMemoryState {
  routeMode?: UserRole;
  turnCount?: number;
  estimatedTokenCount?: number;
  carryoverSummary?: string;
  carryoverSourceSessionId?: string;
  carryoverSourceLastActiveAt?: string;
  pendingInboundAttachments?: PendingInboundAttachment[];
}

interface PendingInboundAttachment {
  id: string;
  kind: "image" | "file";
  fileName: string;
  receivedAt: string;
  localPath?: string;
  sizeBytes?: number;
  md5?: string;
  downloadStatus: "ready" | "failed";
  errorMessage?: string;
}

function parseSessionMemory(memoryJson: string): SessionMemoryState {
  try {
    const parsed = JSON.parse(memoryJson) as Record<string, unknown>;
    return {
      ...(parsed.routeMode === "admin" || parsed.routeMode === "family"
        ? { routeMode: parsed.routeMode }
        : {}),
      ...(typeof parsed.turnCount === "number" && parsed.turnCount >= 0
        ? { turnCount: parsed.turnCount }
        : {}),
      ...(typeof parsed.estimatedTokenCount === "number" &&
      parsed.estimatedTokenCount >= 0
        ? { estimatedTokenCount: parsed.estimatedTokenCount }
        : {}),
      ...(typeof parsed.carryoverSummary === "string"
        ? { carryoverSummary: parsed.carryoverSummary }
        : {}),
      ...(typeof parsed.carryoverSourceSessionId === "string"
        ? { carryoverSourceSessionId: parsed.carryoverSourceSessionId }
        : {}),
      ...(typeof parsed.carryoverSourceLastActiveAt === "string"
        ? { carryoverSourceLastActiveAt: parsed.carryoverSourceLastActiveAt }
        : {}),
      ...(Array.isArray(parsed.pendingInboundAttachments)
        ? {
            pendingInboundAttachments: parsed.pendingInboundAttachments
              .map(parsePendingInboundAttachment)
              .filter(
                (item): item is PendingInboundAttachment => Boolean(item),
              ),
          }
        : {}),
    };
  } catch {
    return {};
  }
}

function parsePendingInboundAttachment(
  value: unknown,
): PendingInboundAttachment | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind === "image" || record.kind === "file"
    ? record.kind
    : undefined;
  const downloadStatus =
    record.downloadStatus === "ready" || record.downloadStatus === "failed"
      ? record.downloadStatus
      : undefined;
  if (
    typeof record.id !== "string" ||
    !kind ||
    typeof record.fileName !== "string" ||
    typeof record.receivedAt !== "string" ||
    !downloadStatus
  ) {
    return undefined;
  }

  return {
    id: record.id,
    kind,
    fileName: record.fileName,
    receivedAt: record.receivedAt,
    ...(typeof record.localPath === "string"
      ? { localPath: record.localPath }
      : {}),
    ...(typeof record.sizeBytes === "number"
      ? { sizeBytes: record.sizeBytes }
      : {}),
    ...(typeof record.md5 === "string" ? { md5: record.md5 } : {}),
    downloadStatus,
    ...(typeof record.errorMessage === "string"
      ? { errorMessage: record.errorMessage }
      : {}),
  };
}

function stringifySessionMemory(state: SessionMemoryState): string {
  return JSON.stringify(state);
}

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.ceil(trimmed.length / 4);
}

function formatSessionSnapshot(params: {
  session: SessionRecord;
  database: AppDatabase;
}): string {
  const session = params.session;
  const parts = [
    `session=${session.id}`,
    `last=${session.lastActiveAt}`,
  ];
  if (session.summaryText.trim()) {
    parts.push(`summary=${session.summaryText.trim()}`);
  } else {
    parts.push("summary=(无)");
  }
  const recentInline = summarizeRecentMessagesInline(
    params.database.listSessionMessages(session.id, 4).reverse(),
  );
  if (recentInline) {
    parts.push(`recent=${recentInline}`);
  }
  return parts.join("\n");
}

function summarizeRecentMessagesInline(
  messages: ReturnType<AppDatabase["listSessionMessages"]>,
): string | undefined {
  const recent = messages
    .slice(-4)
    .map((message) => {
      const speaker = message.direction === "inbound" ? "用户" : "助手";
      const text = message.textContent?.trim() || "[非文本消息]";
      return `${speaker}：${text}`;
    })
    .filter(Boolean);

  return recent.length > 0 ? recent.join(" / ") : undefined;
}

function findPreviousSession(params: {
  database: AppDatabase;
  session: SessionRecord;
}): SessionRecord | undefined {
  const sessions = params.database.listSessionsByPeer(
    params.session.wechatAccountId,
    params.session.contactId,
    10,
  );
  return sessions.find((candidate) => candidate.id !== params.session.id);
}

function findYesterdaySession(params: {
  database: AppDatabase;
  session: SessionRecord;
}): SessionRecord | undefined {
  const sessions = params.database.listSessionsByPeer(
    params.session.wechatAccountId,
    params.session.contactId,
    20,
  );
  const today = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  return sessions.find((candidate) => {
    if (candidate.id === params.session.id) {
      return false;
    }
    const date = new Date(candidate.lastActiveAt);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    const candidateDay = date.toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
    });
    return candidateDay !== today;
  });
}

function isNewBeijingCalendarDay(params: {
  previousAt: string;
  now: Date;
}): boolean {
  const previous = new Date(params.previousAt);
  if (Number.isNaN(previous.getTime())) {
    return false;
  }

  const previousDay = previous.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  const currentDay = params.now.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  return previousDay !== currentDay;
}

function summarizeCarryoverContext(params: {
  session: SessionRecord;
  recentMessages: ReturnType<AppDatabase["listSessionMessages"]>;
}): string {
  const lines: string[] = [];
  if (params.session.summaryText.trim()) {
    lines.push(`上段摘要：${params.session.summaryText.trim()}`);
  }

  const recent = params.recentMessages
    .slice(-6)
    .map((message) => {
      const speaker = message.direction === "inbound" ? "用户" : "助手";
      const text = message.textContent?.trim() || "[非文本消息]";
      return `${speaker}：${text}`;
    });

  if (recent.length > 0) {
    lines.push(`上段最近消息：${recent.join(" / ")}`);
  }

  return lines.join("\n").trim();
}

function buildDeterministicSessionSummary(params: {
  session: SessionRecord;
  recentMessages: ReturnType<AppDatabase["listSessionMessages"]>;
}): string {
  const parts: string[] = [];

  const recentInline = summarizeRecentMessagesInline(params.recentMessages);
  if (recentInline) {
    parts.push(`最近对话：${recentInline}`);
  }

  const attachmentMentions = params.recentMessages
    .filter((message) => message.filePath)
    .slice(-3)
    .map((message) => path.basename(message.filePath ?? ""))
    .filter(Boolean);
  if (attachmentMentions.length > 0) {
    parts.push(`相关文件：${attachmentMentions.join("、")}`);
  }

  if (parts.length === 0) {
    return "";
  }

  return parts.join("\n");
}

function shouldRotateByThresholds(params: {
  session: SessionRecord;
  memory: SessionMemoryState;
  config: AppConfig;
}): { shouldRotate: boolean; reason: string } {
  const now = new Date();
  if (
    isNewBeijingCalendarDay({
      previousAt: params.session.lastActiveAt,
      now,
    })
  ) {
    return {
      shouldRotate: true,
      reason: "crossed into a new Beijing calendar day",
    };
  }

  const idleDecision = shouldRotateSession({
    lastActiveAt: params.session.lastActiveAt,
    now,
    maxIdleHours: params.config.session.rotateIdleHours,
  });
  if (idleDecision.shouldRotate) {
    return idleDecision;
  }

  const turnCount = params.memory.turnCount ?? 0;
  if (turnCount >= params.config.session.rotateMaxTurns) {
    return {
      shouldRotate: true,
      reason: `turn count ${turnCount} >= ${params.config.session.rotateMaxTurns}`,
    };
  }

  const estimatedTokenCount = params.memory.estimatedTokenCount ?? 0;
  if (estimatedTokenCount >= params.config.session.rotateMaxEstimatedTokens) {
    return {
      shouldRotate: true,
      reason: `estimated tokens ${estimatedTokenCount} >= ${params.config.session.rotateMaxEstimatedTokens}`,
    };
  }

  return {
    shouldRotate: false,
    reason: "session is still warm",
  };
}

function buildCrossDayNotice(params: {
  previousLastActiveAt: string;
  now: Date;
}): string | undefined {
  const previous = new Date(params.previousLastActiveAt);
  if (Number.isNaN(previous.getTime())) {
    return undefined;
  }

  const previousDay = previous.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  const currentDay = params.now.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  if (previousDay === currentDay) {
    return undefined;
  }

  return "前置信息：这条消息属于新的一天里的新对话；如当前语境需要，再自然参考上一段对话摘要，不要生硬提起。";
}

function detectPreviousSessionReference(
  text: string,
): "previous" | "yesterday" | undefined {
  const normalized = text.replace(/\s+/g, "");

  if (
    /(昨天那个|昨天那次|昨天那份|昨天说的|昨天聊的|昨天做的|昨天发的|昨天提到的|前天那个|前天那次)/.test(
      normalized,
    )
  ) {
    return "yesterday";
  }

  if (
    /(上一次|上回|上次|上一段|之前那个|前面的那个|之前那次|上个对话|刚才那个)/.test(
      normalized,
    )
  ) {
    return "previous";
  }

  return undefined;
}

function buildPreviousSessionHint(params: {
  database: AppDatabase;
  session: SessionRecord;
  userText: string;
}): string | undefined {
  const referenceKind = detectPreviousSessionReference(params.userText);
  if (!referenceKind) {
    return undefined;
  }

  const previous =
    referenceKind === "yesterday"
      ? findYesterdaySession({
          database: params.database,
          session: params.session,
        }) ??
        findPreviousSession({
          database: params.database,
          session: params.session,
        })
      : findPreviousSession({
          database: params.database,
          session: params.session,
        }) ??
        findYesterdaySession({
          database: params.database,
          session: params.session,
        });

  if (!previous) {
    return undefined;
  }

  const recentMessages = params.database
    .listSessionMessages(previous.id, 4)
    .reverse();
  const lines = [
    referenceKind === "yesterday"
      ? "前置信息：用户这次提到了昨天的那段内容，如相关可参考上一段对话信息。"
      : "前置信息：用户这次提到了上一次/之前那段内容，如相关可参考上一段对话信息。",
    `上一段对话时间：${previous.lastActiveAt}`,
  ];
  if (previous.summaryText.trim()) {
    lines.push(`上一段对话摘要：${previous.summaryText.trim()}`);
  }
  const recentInline = summarizeRecentMessagesInline(recentMessages);
  if (recentInline) {
    lines.push(`上一段最近消息：${recentInline}`);
  }
  return lines.join("\n");
}

function buildDayChangeUserNotice(params: {
  session: SessionRecord;
  role: UserRole;
  now: Date;
}): string | undefined {
  if (
    !isNewBeijingCalendarDay({
      previousAt: params.session.lastActiveAt,
      now: params.now,
    })
  ) {
    return undefined;
  }

  return params.role === "family"
    ? "昨天那段我先收起来了，我们接着聊；要回看上一段可以发 /last 或 /yesterday。"
    : "已按新的一天开启新对话；如需回看上一段，可用 /last 或 /yesterday。";
}

function buildCommandReply(params: {
  command: ParsedCommand;
  session: SessionRecord;
  database: AppDatabase;
  role: UserRole;
  accountRole: UserRole;
  sessionMemory: SessionMemoryState;
  account: WechatAccountRecord;
  config: AppConfig;
  onRoleModeChanged?: (nextRole: UserRole) => void;
}): string {
  switch (params.command.name) {
    case "/time":
      return `现在是北京时间 ${formatBeijingTime(new Date())}。`;
    case "/help":
      return params.role === "admin"
        ? [
            "可用命令：",
            "/time 查看北京时间",
            "/whoami 查看当前账号角色",
            "/mode 查看或切换当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/sessions 查看最近会话",
            "/recent 查看最近几条消息",
            "/summary 查看当前摘要",
            "/new 或 /reset 重置当前对话上下文",
            "/file <文件路径> [说明] 发送允许目录里的服务器文件",
            "/files 查看最近可发送文件",
            "/accounts 查看已绑定微信账号",
          ].join("\n")
        : [
            "可用命令：",
            "/time 查看北京时间",
            "/whoami 查看当前账号角色",
            "/mode 查看当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/new 或 /reset 重置当前对话上下文",
          ].join("\n");
    case "/whoami":
      return [
        `角色：${params.role}`,
        `账号默认角色：${params.accountRole}`,
        `当前模式：${params.sessionMemory.routeMode ?? params.role}`,
        `账号：${params.account.id}`,
        `会话：${params.session.id}`,
      ].join("\n");
    case "/mode": {
      const requested = params.command.args[0]?.trim().toLowerCase();
      const currentMode = params.sessionMemory.routeMode ?? params.role;
      if (!requested) {
        return [
          `当前模式：${currentMode}`,
          params.accountRole === "admin"
            ? "可用：/mode admin 或 /mode family"
            : "普通 family 账号不能切到 admin。",
        ].join("\n");
      }

      if (requested !== "admin" && requested !== "family") {
        return "用法：/mode admin 或 /mode family";
      }

      if (requested === "admin" && params.accountRole !== "admin") {
        return "普通 family 账号不能切到 admin。";
      }

      const nextRole = requested as UserRole;
      const nextMemory = stringifySessionMemory({
        ...params.sessionMemory,
        routeMode: nextRole,
      });
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: nextRole,
        status: params.session.status,
        summaryText: params.session.summaryText,
        memoryJson: nextMemory,
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      params.onRoleModeChanged?.(nextRole);
      return nextRole === "admin"
        ? "当前会话已切到 admin 模式。"
        : "当前会话已切到 family 模式。";
    }
    case "/sessions":
      return buildSessionsReply(params);
    case "/accounts":
      return buildAccountsReply(params);
    case "/files":
      return buildFilesReply(params);
    case "/summary":
      return params.session.summaryText.trim()
        ? `当前摘要：${params.session.summaryText}`
        : "当前还没有保存摘要。";
    case "/memory": {
      const parts = [
        `turn_count=${params.sessionMemory.turnCount ?? 0}`,
        `estimated_tokens=${params.sessionMemory.estimatedTokenCount ?? 0}`,
      ];
      if (params.sessionMemory.carryoverSourceSessionId) {
        parts.push(
          `carryover_session=${params.sessionMemory.carryoverSourceSessionId}`,
        );
      }
      if (params.sessionMemory.carryoverSourceLastActiveAt) {
        parts.push(
          `carryover_last=${params.sessionMemory.carryoverSourceLastActiveAt}`,
        );
      }
      if (params.sessionMemory.carryoverSummary?.trim()) {
        parts.push(`carryover_summary=${params.sessionMemory.carryoverSummary}`);
      }
      return `当前 memory：\n${parts.join("\n")}`;
    }
    case "/last": {
      const previous = findPreviousSession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `上一段对话：\n${formatSessionSnapshot({
            session: previous,
            database: params.database,
          })}`
        : "当前还没有上一段对话。";
    }
    case "/yesterday": {
      const previous = findYesterdaySession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `昨天的上一段对话：\n${formatSessionSnapshot({
            session: previous,
            database: params.database,
          })}`
        : "当前还没有可用的昨天对话。";
    }
    case "/recent": {
      const recent = params.database
        .listSessionMessages(params.session.id, 6)
        .reverse()
        .map((message) => {
          const speaker = message.direction === "inbound" ? "用户" : "助手";
          const text = message.textContent?.trim() || "[非文本消息]";
          return `${speaker}：${text}`;
        });
      return recent.length > 0
        ? `最近消息：\n${recent.join("\n")}`
        : "当前会话里还没有最近消息。";
    }
    case "/new":
    case "/reset":
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.sessionMemory.routeMode ?? params.role,
        status: "active",
        summaryText: "",
        memoryJson: stringifySessionMemory({
          ...(params.sessionMemory.routeMode
            ? { routeMode: params.sessionMemory.routeMode }
            : {}),
        }),
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      return "当前对话上下文已经重置，我们可以重新开始。";
    default:
      return "暂不支持这个内建命令。";
  }
}

function buildAccountsReply(params: {
  database: AppDatabase;
  role: UserRole;
}): string {
  if (params.role !== "admin") {
    return "这个账号命令只对 admin 开放。";
  }

  const accounts = params.database.listAccounts();
  if (accounts.length === 0) {
    return "当前还没有绑定微信账号。";
  }

  return [
    "已绑定微信账号：",
    ...accounts.map((account) =>
      [
        account.id,
        `role=${account.role}`,
        `status=${account.status}`,
        `updated=${account.updatedAt}`,
      ].join("  "),
    ),
  ].join("\n");
}

function buildSessionsReply(params: {
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
}): string {
  if (params.role !== "admin") {
    return [
      "当前对话：",
      `session=${params.session.id}`,
      `last=${params.session.lastActiveAt}`,
    ].join("\n");
  }

  const sessions = params.database.listRecentSessions(10);
  if (sessions.length === 0) {
    return "当前还没有会话。";
  }

  return [
    "最近会话：",
    ...sessions.map((session) =>
      [
        `session=${session.id}`,
        `role=${session.role}`,
        `account=${session.wechatAccountId}`,
        `contact=${session.contactId}`,
        `last=${session.lastActiveAt}`,
        `summary=${session.summaryText.trim() ? "yes" : "no"}`,
      ].join("  "),
    ),
  ].join("\n");
}

function buildFilesReply(params: {
  config: AppConfig;
  role: UserRole;
}): string {
  if (params.role !== "admin") {
    return "这个文件命令只对 admin 开放。";
  }

  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  for (const directory of params.config.fileSend.allowedDirs) {
    if (!fs.existsSync(directory)) {
      continue;
    }

    for (const filePath of listFilesForReply(directory, 2)) {
      const stat = fs.statSync(filePath);
      if (stat.size > params.config.fileSend.maxBytes) {
        continue;
      }

      files.push({
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const recent = files.slice(0, 10);
  if (recent.length === 0) {
    return [
      "白名单目录里暂时没有可发送文件。",
      `允许目录：${params.config.fileSend.allowedDirs.join(", ")}`,
    ].join("\n");
  }

  return [
    "最近可发送文件：",
    ...recent.map(
      (file) => `${file.filePath}  ${formatBytes(file.size)}`,
    ),
  ].join("\n");
}

function listFilesForReply(directory: string, maxDepth: number): string[] {
  const files: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [
    { directory, depth: 0 },
  ];

  while (stack.length > 0 && files.length < 200) {
    const current = stack.pop();
    if (!current) {
      break;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(current.directory, entry.name);
      if (entry.isFile()) {
        files.push(filePath);
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ directory: filePath, depth: current.depth + 1 });
      }

      if (files.length >= 200) {
        break;
      }
    }
  }

  return files;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let next = value / 1024;
  for (const unit of units) {
    if (next < 1024 || unit === units[units.length - 1]) {
      return `${next.toFixed(next >= 10 ? 1 : 2)} ${unit}`;
    }
    next /= 1024;
  }

  return `${value} B`;
}

function sanitizeFileName(fileName: string): string {
  const sanitized = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "attachment";
}

function buildInboundAttachmentPath(params: {
  config: AppConfig;
  sessionId: string;
  sourceMessageId: string;
  index: number;
  fileName: string;
}): string {
  const safeMessageId = params.sourceMessageId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeFileName = sanitizeFileName(params.fileName);
  return path.join(
    params.config.server.dataDir,
    "inbox",
    params.sessionId,
    `${safeMessageId}-${params.index + 1}-${safeFileName}`,
  );
}

function buildSessionWorkspacePaths(params: {
  config: AppConfig;
  sessionId: string;
}): {
  inboxDir: string;
  officeDir: string;
  outboxDir: string;
} {
  return {
    inboxDir: path.join(
      params.config.server.dataDir,
      "inbox",
      params.sessionId,
    ),
    officeDir: path.join(
      params.config.server.dataDir,
      "office",
      params.sessionId,
    ),
    outboxDir: path.join(
      params.config.server.dataDir,
      "outbox",
      params.sessionId,
    ),
  };
}

function ensureSessionWorkspaceDirs(params: {
  config: AppConfig;
  sessionId: string;
}): void {
  const paths = buildSessionWorkspacePaths(params);
  for (const directory of Object.values(paths)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function buildSessionWorkspacePromptBlock(params: {
  config: AppConfig;
  role: UserRole;
  session: SessionRecord;
}): string | undefined {
  if (params.role !== "family") {
    return undefined;
  }

  const paths = buildSessionWorkspacePaths({
    config: params.config,
    sessionId: params.session.id,
  });

  return [
    "当前会话受控工作区：",
    `- inbox: ${paths.inboxDir}`,
    `- office: ${paths.officeDir}`,
    `- outbox: ${paths.outboxDir}`,
    "优先只读写这个会话自己的工作区，不要访问其他会话目录。",
    "如果生成可发回用户的成品文件，请写入当前会话的 outbox 目录。",
    "如需把当前会话 outbox 里的文件发回微信，只输出动作标记：[[send_file path=\"/absolute/path\" caption=\"可选说明\"]]。不要解释这个标记。",
  ].join("\n");
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function buildAttachmentPromptBlock(
  attachments: PendingInboundAttachment[],
): string {
  const lines = attachments.map((attachment, index) => {
    const parts = [
      `${index + 1}. ${attachment.kind === "image" ? "图片" : "文件"}：${attachment.fileName}`,
      attachment.sizeBytes !== undefined
        ? `大小 ${formatBytes(attachment.sizeBytes)}`
        : undefined,
      attachment.localPath && attachment.downloadStatus === "ready"
        ? `本地路径 ${attachment.localPath}`
        : undefined,
      attachment.downloadStatus === "failed"
        ? `下载失败：${attachment.errorMessage ?? "未知错误"}`
        : undefined,
    ].filter(Boolean);
    return parts.join("，");
  });

  return [
    "用户刚才发来的附件：",
    ...lines,
    "如果附件已有本地路径，可以读取/处理该文件；如果处理后生成新文件，应写入 outbox 或 office 目录，方便发回微信。",
  ].join("\n");
}

function buildMediaAckReply(params: {
  role: UserRole;
  attachments: PendingInboundAttachment[];
}): string {
  const failed = params.attachments.filter(
    (attachment) => attachment.downloadStatus === "failed",
  );
  if (failed.length === params.attachments.length) {
    return params.role === "admin"
      ? [
          "我看到你发了附件，但下载没有成功。",
          ...failed.map(
            (attachment) =>
              `${attachment.fileName}: ${attachment.errorMessage ?? "未知错误"}`,
          ),
          "你可以再发一句要怎么处理，或者稍后重发附件。",
        ].join("\n")
      : "我看到你发了附件，但这边暂时没下载成功。你可以再发一句要我怎么处理，或者稍后重发一下。";
  }

  const names = params.attachments
    .map((attachment) => attachment.fileName)
    .slice(0, 3)
    .join("、");
  return params.role === "admin"
    ? `收到附件：${names}。你再发一句处理要求，我再开始处理。`
    : `收到${names ? `：${names}` : "附件"}。你再说一句想让我怎么处理，我再开始。`;
}

function extractQuotedText(text: string): string | undefined {
  const match = text.match(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/);
  return match?.[1]?.trim() || undefined;
}

function extractAbsolutePath(text: string): string | undefined {
  const quoted = extractQuotedText(text);
  if (quoted && (path.isAbsolute(quoted) || /^[A-Za-z]:[\\/]/.test(quoted))) {
    return quoted;
  }

  const match = text.match(
    /(?:^|\s)((?:\/[^\s"'“”‘’]+)+|[A-Za-z]:[\\/][^\s"'“”‘’]+)/,
  );
  return match?.[1]?.trim() || undefined;
}

function parseNaturalFileRequest(text: string): ParsedCommand | undefined {
  const hasSendIntent = /(发|发送|传|传给|send)\s*/i.test(text);
  if (!hasSendIntent) {
    return undefined;
  }

  const filePath = extractAbsolutePath(text);
  if (!filePath) {
    return undefined;
  }

  const caption = text.replace(filePath, "").replace(/["'“”‘’]/g, "").trim();
  return {
    name: "/file",
    raw: text,
    args: caption ? [filePath, caption] : [filePath],
  };
}

function parseAssistantFileAction(text: string):
  | {
      command: ParsedCommand;
      cleanedText: string;
    }
  | undefined {
  const match = text.match(
    /\[\[send_file\s+path=(?:"([^"]+)"|'([^']+)'|([^\]\s]+))(?:\s+caption=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\s*\]\]/i,
  );
  if (!match) {
    return undefined;
  }

  const filePath = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  const caption = (match[4] ?? match[5] ?? match[6] ?? "").trim();
  if (!filePath) {
    return undefined;
  }

  return {
    command: {
      name: "/file",
      raw: match[0],
      args: caption ? [filePath, caption] : [filePath],
    },
    cleanedText: text.replace(match[0], "").trim(),
  };
}

function splitReplyText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (maxChars <= 0 || trimmed.length <= maxChars) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const cutAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" "),
    );
    const end = cutAt > Math.floor(maxChars * 0.45) ? cutAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function buildCommandErrorReply(params: {
  error: unknown;
  role: UserRole;
}): string {
  const message = errorToRedactedMessage(params.error);

  return params.role === "admin"
    ? `命令执行失败：${message}`
    : "这个命令暂时没有执行成功。";
}

async function handleFileCommand(params: {
  command: ParsedCommand;
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  role: UserRole;
}): Promise<string> {
  if (params.role !== "admin") {
    return "这个文件命令只对 admin 开放。";
  }

  if (!params.config.familyPolicy.allowFileSend) {
    return "文件发送当前已被配置关闭。";
  }

  const [rawFilePath, ...captionParts] = params.command.args;
  if (!rawFilePath) {
    return [
      "用法：/file <文件路径> [说明文字]",
      `允许目录：${params.config.fileSend.allowedDirs.join(", ")}`,
    ].join("\n");
  }

  if (!params.session.contextToken.trim()) {
    return "当前会话缺少 context_token。请先从这个微信会话再发一条普通消息。";
  }

  const filePath = path.resolve(rawFilePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是普通文件：${filePath}`);
  }

  if (stat.size > params.config.fileSend.maxBytes) {
    throw new Error(
      `文件太大：${formatBytes(stat.size)}，上限 ${formatBytes(
        params.config.fileSend.maxBytes,
      )}`,
    );
  }

  assertFileAllowedForWechatCommand(filePath, params.config.fileSend);

  const caption = captionParts.join(" ").trim();
  const result = await sendLocalFileToSession({
    client: params.client,
    database: params.database,
    session: params.session,
    filePath,
    ...(caption ? { caption } : {}),
  });

  return [
    "文件已发送。",
    `文件：${result.fileName}`,
    `大小：${formatBytes(result.sizeBytes)}`,
    `MD5：${result.plaintextMd5}`,
  ].join("\n");
}

async function downloadInboundAttachments(params: {
  attachments: NormalizedInboundAttachment[];
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  sourceMessageId: string;
  receivedAt: string;
}): Promise<PendingInboundAttachment[]> {
  const pending: PendingInboundAttachment[] = [];

  for (const [index, attachment] of params.attachments.entries()) {
    const id = buildMessageId("inbound-attachment");
    const fileName = sanitizeFileName(attachment.fileName);
    const localPath = buildInboundAttachmentPath({
      config: params.config,
      sessionId: params.session.id,
      sourceMessageId: params.sourceMessageId,
      index,
      fileName,
    });

    try {
      if (!attachment.media) {
        throw new Error("附件缺少 CDN media 信息");
      }

      const buffer = await downloadEncryptedMediaFromCdn({
        client: params.client,
        media: attachment.media,
        ...(attachment.aesKeyOverride
          ? { aesKeyOverride: attachment.aesKeyOverride }
          : {}),
        maxPlaintextBytes: params.config.fileSend.maxBytes,
        ...(attachment.md5 ? { expectedMd5: attachment.md5 } : {}),
        ...(attachment.kind === "file" && attachment.sizeBytes !== undefined
          ? { expectedSize: attachment.sizeBytes }
          : {}),
      });

      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, buffer);
      params.database.saveAttachment({
        id,
        sessionId: params.session.id,
        localPath,
        mimeType: inferMimeType(localPath),
        fileName,
        sizeBytes: buffer.length,
        outboundStatus: "inbound-ready",
        createdAt: params.receivedAt,
      });
      params.database.appendMessage({
        id: buildMessageId("inbound-file"),
        sessionId: params.session.id,
        direction: "inbound",
        messageType: attachment.kind,
        filePath: localPath,
        createdAt: params.receivedAt,
        sourceMessageId: params.sourceMessageId,
      });

      pending.push({
        id,
        kind: attachment.kind,
        fileName,
        receivedAt: params.receivedAt,
        localPath,
        sizeBytes: buffer.length,
        ...(attachment.md5 ? { md5: attachment.md5 } : {}),
        downloadStatus: "ready",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[worker] failed to download inbound ${attachment.kind}`, {
        fileName,
        error: message,
      });
      pending.push({
        id,
        kind: attachment.kind,
        fileName,
        receivedAt: params.receivedAt,
        ...(attachment.sizeBytes !== undefined
          ? { sizeBytes: attachment.sizeBytes }
          : {}),
        ...(attachment.md5 ? { md5: attachment.md5 } : {}),
        downloadStatus: "failed",
        errorMessage: message,
      });
    }
  }

  return pending;
}

function buildCodexBootstrapPrompt(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
}): string {
  const summary = params.session.summaryText.trim()
    ? {
        lastActiveAt: params.session.lastActiveAt,
        summary: params.session.summaryText,
        facts: [],
        openLoops: [],
      }
    : undefined;
  const promptContext = buildPromptContext({
    role: params.role,
    now: new Date(),
    ...(summary ? { summary } : {}),
  });

  const recentMessages = params.database
    .listSessionMessages(params.session.id, 12)
    .reverse()
    .map((message) => {
      const speaker = message.direction === "inbound" ? "用户" : "助手";
      const text = message.textContent?.trim() || "[非文本消息]";
      return `${speaker}（${message.createdAt}）：${text}`;
    });

  const roleInstruction =
    params.role === "admin"
      ? [
          "前置信息：当前路由是 admin。",
          "如果用户明确要求发送服务器本地文件，且你知道绝对路径，可以只输出动作标记：[[send_file path=\"/absolute/path\" caption=\"可选说明\"]]。不要解释这个标记。",
        ].join("\n")
      : "前置信息：当前路由是 family。";
  const sessionMemory = parseSessionMemory(params.session.memoryJson);
  const carryoverInstruction = sessionMemory.carryoverSummary
    ? [
        buildCrossDayNotice({
          previousLastActiveAt:
            sessionMemory.carryoverSourceLastActiveAt ?? params.session.lastActiveAt,
          now: new Date(),
        }) ?? "前置信息：这里附带上一段对话的简要信息，如和当前问题相关再使用。",
        `上一段对话简要信息：\n${sessionMemory.carryoverSummary}`,
      ].join("\n")
    : undefined;
  const workspaceInstruction = buildSessionWorkspacePromptBlock({
    config: params.config,
    role: params.role,
    session: params.session,
  });
  const previousSessionHint = buildPreviousSessionHint({
    database: params.database,
    session: params.session,
    userText: params.userText,
  });

  return [
    promptContext.currentTimeText,
    promptContext.assistantInstruction,
    promptContext.summaryBlock ? `\n会话摘要：\n${promptContext.summaryBlock}` : "",
    `\n${roleInstruction}`,
    carryoverInstruction ? `\n${carryoverInstruction}` : "",
    previousSessionHint ? `\n${previousSessionHint}` : "",
    workspaceInstruction ? `\n${workspaceInstruction}` : "",
    "\n最近对话：",
    recentMessages.length > 0 ? recentMessages.join("\n") : "（暂无）",
    "\n用户最新消息：",
    params.userText,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCodexIncrementalPrompt(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
}): string {
  const promptContext = buildPromptContext({
    role: params.role,
    now: new Date(),
  });
  const workspaceInstruction = buildSessionWorkspacePromptBlock({
    config: params.config,
    role: params.role,
    session: params.session,
  });
  const previousSessionHint = buildPreviousSessionHint({
    database: params.database,
    session: params.session,
    userText: params.userText,
  });

  return [
    promptContext.currentTimeText,
    previousSessionHint ? `\n${previousSessionHint}` : "",
    workspaceInstruction ? `\n${workspaceInstruction}` : "",
    "\n用户最新消息：",
    params.userText,
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildCodexReply(params: {
  backend: CodexBackend;
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
  persistentContext: boolean;
  responseMode?: CodexResponseMode;
  onProgress?: (event: CodexProgressEvent) => void;
}): Promise<string> {
  const prompt = params.persistentContext
    ? buildCodexIncrementalPrompt({
        config: params.config,
        database: params.database,
        role: params.role,
        session: params.session,
        userText: params.userText,
      })
    : buildCodexBootstrapPrompt({
        config: params.config,
        database: params.database,
        role: params.role,
        session: params.session,
        userText: params.userText,
      });
  const bootstrapPrompt = params.persistentContext
    ? buildCodexBootstrapPrompt({
        config: params.config,
        database: params.database,
        role: params.role,
        session: params.session,
        userText: params.userText,
      })
    : undefined;
  const result = await params.backend.run({
    conversationId: params.session.id,
    prompt,
    ...(bootstrapPrompt ? { bootstrapPrompt } : {}),
    role: params.role,
    ...(params.responseMode ? { responseMode: params.responseMode } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });

  if (result.timedOut) {
    throw new Error("Codex timed out");
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr || result.text || `exit code ${result.exitCode}`;
    throw new Error(`Codex failed: ${detail}`);
  }

  if (!result.text.trim()) {
    throw new Error(result.stderr || "Codex returned an empty response");
  }

  return result.text;
}

function buildCodexErrorReply(params: {
  error: unknown;
  role: UserRole;
  codexCommand?: string;
}): string {
  const message = errorToRedactedMessage(params.error);
  const codexCommand = params.codexCommand ?? "codex";

  if (params.role === "admin") {
    return [
      "Codex 调用失败了。",
      message,
      `可以先在服务器上用同一个用户执行 \`${codexCommand} exec --skip-git-repo-check "你好"\` 验证登录和非交互执行是否正常。`,
    ].join("\n");
  }

  return "我这边调用助手时出了一点问题，先稍等一下再试。";
}

async function handleAssistantFileActions(params: {
  rawReply: string;
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  role: UserRole;
}): Promise<string> {
  const action = parseAssistantFileAction(params.rawReply);
  if (!action) {
    return params.rawReply;
  }

  if (params.role === "family") {
    const { outboxDir } = buildSessionWorkspacePaths({
      config: params.config,
      sessionId: params.session.id,
    });
    const requestedPath = path.resolve(action.command.args[0] ?? "");
    if (
      !requestedPath ||
      !fs.existsSync(requestedPath) ||
      !isInsideDirectory(requestedPath, outboxDir)
    ) {
      return action.cleanedText;
    }
  } else if (params.role !== "admin") {
    return params.rawReply;
  }

  const fileReply = await handleFileCommand({
    command: action.command,
    config: params.config,
    client: params.client,
    database: params.database,
    session: params.session,
    role: params.role,
  });

  return [action.cleanedText, fileReply].filter(Boolean).join("\n");
}

async function withTypingIndicator<T>(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  typingRefreshMs: number;
  thinkingNoticeIntervalMs: number;
  shouldSendThinkingNotice?: () => boolean;
  buildThinkingNoticeText: (elapsedSeconds: number) => string;
  work: () => Promise<T>;
}): Promise<T> {
  let typingTicket = "";
  let refreshing = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  let thinkingTimer: NodeJS.Timeout | undefined;
  let thinkingNoticeCount = 0;
  let sendingThinkingNotice = false;

  const sendTypingStatus = async (status: 1 | 2): Promise<void> => {
    if (!typingTicket) {
      return;
    }

    await params.client.sendTyping({
      ilink_user_id: params.toUserId,
      typing_ticket: typingTicket,
      status,
    });
  };

  try {
    const config = await params.client.getConfig(
      params.toUserId,
      params.contextToken,
    );
    typingTicket = config.typing_ticket?.trim() ?? "";

    if (typingTicket) {
      await sendTypingStatus(1);
      if (params.typingRefreshMs > 0) {
        refreshTimer = setInterval(() => {
          if (refreshing) {
            return;
          }

          refreshing = true;
          sendTypingStatus(1)
            .catch((error) => {
              console.warn("[worker] failed to refresh typing indicator", error);
            })
            .finally(() => {
              refreshing = false;
            });
        }, params.typingRefreshMs);
      }
    }
  } catch (error) {
    console.warn("[worker] failed to start typing indicator", error);
  }

  if (params.thinkingNoticeIntervalMs > 0) {
    thinkingTimer = setInterval(() => {
      if (params.shouldSendThinkingNotice && !params.shouldSendThinkingNotice()) {
        return;
      }
      if (sendingThinkingNotice) {
        return;
      }

      thinkingNoticeCount += 1;
      sendingThinkingNotice = true;
      sendTextMessage({
        client: params.client,
        toUserId: params.toUserId,
        contextToken: params.contextToken,
        text: params.buildThinkingNoticeText(
          Math.round(
            (thinkingNoticeCount * params.thinkingNoticeIntervalMs) / 1000,
          ),
        ),
      })
        .catch((error) => {
          console.warn("[worker] failed to send thinking notice", error);
        })
        .finally(() => {
          sendingThinkingNotice = false;
        });
    }, params.thinkingNoticeIntervalMs);
  }

  try {
    return await params.work();
  } finally {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
    }

    if (typingTicket) {
      try {
        await sendTypingStatus(2);
      } catch (error) {
        console.warn("[worker] failed to stop typing indicator", error);
      }
    }
  }
}

function buildThinkingNoticeText(params: {
  role: UserRole;
  elapsedSeconds: number;
}): string {
  return params.role === "admin"
    ? `我已思考 ${params.elapsedSeconds} 秒，还在处理，稍等一下。`
    : `我已经想了 ${params.elapsedSeconds} 秒，还在处理，稍等我一下哦。`;
}

export interface WechatWorkerOptions {
  config: AppConfig;
  database: AppDatabase;
}

export class WechatWorker {
  private running = false;

  private loopPromise: Promise<void> | undefined;

  private readonly codexBackends: Record<UserRole, CodexBackend>;

  constructor(private readonly options: WechatWorkerOptions) {
    this.codexBackends = {
      admin: createCodexBackend(options.config.codex.admin),
      family: createCodexBackend(options.config.codex.family),
    };
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.codexBackends.admin.dispose();
    this.codexBackends.family.dispose();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const accounts = this.options.database
        .listAccounts()
        .filter((account) => account.status === "active");

      if (accounts.length === 0) {
        await sleep(2_000);
        continue;
      }

      for (const account of accounts) {
        if (!this.running) {
          return;
        }

        try {
          await this.pollAccount(account);
        } catch (error) {
          console.error(`[worker] failed to poll ${account.id}`, error);
          await sleep(1_000);
        }
      }
    }
  }

  private async pollAccount(account: WechatAccountRecord): Promise<void> {
    const client = new ILinkApiClient({
      baseUrl: account.baseUrl ?? this.options.config.wechat.apiBaseUrl,
      cdnBaseUrl: this.options.config.wechat.cdnBaseUrl,
      channelVersion: this.options.config.wechat.channelVersion,
      ...(this.options.config.wechat.routeTag
        ? { routeTag: this.options.config.wechat.routeTag }
        : {}),
      token: account.authToken,
    });

    const cursor = this.options.database.getPollingCursor(account.id) ?? "";
    const response = await client.getUpdates(cursor);

    if (response.get_updates_buf) {
      this.options.database.savePollingCursor(
        account.id,
        response.get_updates_buf,
      );
    }

    const inboundMessages = normalizeInboundWechatMessages({
      wechatAccountId: account.id,
      messages: response.msgs ?? [],
    });

    for (const inbound of inboundMessages) {
      await this.handleInboundMessage(account, client, inbound);
    }
  }

  private async handleInboundMessage(
    account: WechatAccountRecord,
    client: ILinkApiClient,
    inbound: ReturnType<typeof normalizeInboundWechatMessages>[number],
  ): Promise<void> {
    const accountRoute = resolveRole({ configuredRole: account.role });
    const session = ensureActiveSession({
      database: this.options.database,
      wechatAccountId: inbound.wechatAccountId,
      contactId: inbound.contactId,
      role: accountRoute.role,
    });
    const existingSessionMemory = parseSessionMemory(session.memoryJson);
    const route: { role: UserRole } =
      existingSessionMemory.routeMode === "admin" ||
      existingSessionMemory.routeMode === "family"
        ? { role: existingSessionMemory.routeMode }
        : { role: accountRoute.role };
    const recentMessagesForCarryover = this.options.database
      .listSessionMessages(session.id, 12)
      .reverse();
    const archivedSummary =
      buildDeterministicSessionSummary({
        session,
        recentMessages: recentMessagesForCarryover,
      }) || session.summaryText;
    const carryoverSummary = summarizeCarryoverContext({
      session,
      recentMessages: recentMessagesForCarryover,
    });
    const rotateDecision = shouldRotateByThresholds({
      session,
      memory: existingSessionMemory,
      config: this.options.config,
    });
    const sessionForTurn = rotateDecision.shouldRotate
        ? createNextSession({
          database: this.options.database,
          previousSession: session,
          role: route.role,
          summaryText: archivedSummary,
          memoryJson: stringifySessionMemory({
            ...(existingSessionMemory.routeMode
              ? { routeMode: existingSessionMemory.routeMode }
              : {}),
            ...(carryoverSummary
              ? {
                  carryoverSummary,
                  carryoverSourceSessionId: session.id,
                  carryoverSourceLastActiveAt: session.lastActiveAt,
                }
              : {}),
          }),
          contextToken: inbound.contextToken,
          lastActiveAt: inbound.receivedAt,
        })
      : session;
    const dayChangeNotice =
      rotateDecision.shouldRotate &&
      rotateDecision.reason === "crossed into a new Beijing calendar day"
        ? buildDayChangeUserNotice({
            session,
            role: route.role,
            now: new Date(),
          })
        : undefined;

    const activeSession = this.options.database.saveSession({
      id: sessionForTurn.id,
      wechatAccountId: sessionForTurn.wechatAccountId,
      contactId: sessionForTurn.contactId,
      role: route.role,
      status: sessionForTurn.status,
      summaryText: sessionForTurn.summaryText,
      memoryJson: sessionForTurn.memoryJson,
      contextToken: inbound.contextToken,
      lastActiveAt: inbound.receivedAt,
    });
    ensureSessionWorkspaceDirs({
      config: this.options.config,
      sessionId: activeSession.id,
    });
    const sessionMemory = parseSessionMemory(activeSession.memoryJson);
    const downloadedAttachments =
      inbound.attachments.length > 0
        ? await downloadInboundAttachments({
            attachments: inbound.attachments,
            config: this.options.config,
            client,
            database: this.options.database,
            session: activeSession,
            sourceMessageId: inbound.sourceMessageId,
            receivedAt: inbound.receivedAt,
          })
        : [];

    this.options.database.appendMessage({
      id: buildMessageId("inbound"),
      sessionId: activeSession.id,
      direction: "inbound",
      messageType: downloadedAttachments.length > 0 ? "mixed" : "text",
      textContent: [inbound.mediaSummary, inbound.text].filter(Boolean).join("\n"),
      createdAt: inbound.receivedAt,
      sourceMessageId: inbound.sourceMessageId,
    });

    if (downloadedAttachments.length > 0 && !inbound.text.trim()) {
      const nextMemory = stringifySessionMemory({
        ...sessionMemory,
        turnCount: (sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          (sessionMemory.estimatedTokenCount ?? 0) +
          estimateTextTokens([inbound.mediaSummary, inbound.text].filter(Boolean).join("\n")),
        pendingInboundAttachments: [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ].slice(-10),
      });
      const nextSession = this.options.database.saveSession({
        id: activeSession.id,
        wechatAccountId: activeSession.wechatAccountId,
        contactId: activeSession.contactId,
        role: route.role,
        status: activeSession.status,
        summaryText: activeSession.summaryText,
        memoryJson: nextMemory,
        contextToken: activeSession.contextToken,
        lastActiveAt: activeSession.lastActiveAt,
      });
      const ack = buildMediaAckReply({
        role: route.role,
        attachments: downloadedAttachments,
      });
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: ack,
      });
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: nextSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: ack,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
      return;
    }

    const parsedCommand =
      parseBuiltInCommand(inbound.text) ??
      (route.role === "admin" ? parseNaturalFileRequest(inbound.text) : undefined);
    const pendingAttachments = parsedCommand
      ? downloadedAttachments
      : [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ];
    const userTextForCodex =
      pendingAttachments.length > 0
        ? `${buildAttachmentPromptBlock(pendingAttachments)}\n\n用户这次的文字要求：\n${inbound.text}`
        : inbound.text;
    const sessionForReply =
      pendingAttachments.length > 0 && !parsedCommand
        ? this.options.database.saveSession({
            id: activeSession.id,
            wechatAccountId: activeSession.wechatAccountId,
            contactId: activeSession.contactId,
            role: route.role,
            status: activeSession.status,
            summaryText: activeSession.summaryText,
            memoryJson: stringifySessionMemory({
              ...sessionMemory,
              pendingInboundAttachments: [],
            }),
            contextToken: activeSession.contextToken,
            lastActiveAt: activeSession.lastActiveAt,
          })
        : activeSession;

    let rawReply: string;

    if (parsedCommand) {
      try {
        if (parsedCommand.name === "/new" || parsedCommand.name === "/reset") {
          this.codexBackends[route.role].clearSession(activeSession.id);
        }

        rawReply =
          parsedCommand.name === "/file" || parsedCommand.name === "/sendfile"
            ? await handleFileCommand({
                command: parsedCommand,
                config: this.options.config,
                client,
                database: this.options.database,
                session: sessionForReply,
                role: route.role,
              })
            : buildCommandReply({
                command: parsedCommand,
                session: sessionForReply,
                database: this.options.database,
                role: route.role,
                accountRole: accountRoute.role,
                sessionMemory: sessionMemory,
                account,
                config: this.options.config,
                onRoleModeChanged: () => {
                  this.codexBackends.admin.clearSession(activeSession.id);
                  this.codexBackends.family.clearSession(activeSession.id);
                },
              });
      } catch (error) {
        console.error("[worker] command failed", error);
        rawReply = buildCommandErrorReply({
          error,
          role: route.role,
        });
      }
    } else {
      try {
        const progress: CodexProgressEvent = { phase: "thinking" };
        rawReply = await withTypingIndicator({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          typingRefreshMs: this.options.config.wechat.typingRefreshMs,
          thinkingNoticeIntervalMs:
            this.options.config.wechat.thinkingNoticeMs,
          shouldSendThinkingNotice: () => progress.phase === "thinking",
          buildThinkingNoticeText: (elapsedSeconds) =>
            buildThinkingNoticeText({
              role: route.role,
              elapsedSeconds,
            }),
          work: () =>
            buildCodexReply({
              backend: this.codexBackends[route.role],
              config: this.options.config,
              database: this.options.database,
              role: route.role,
              session: sessionForReply,
              userText: userTextForCodex,
              persistentContext:
                this.options.config.codex[route.role].backend === "acp",
              responseMode:
                route.role === "family" &&
                this.options.config.codex[route.role].backend === "acp"
                  ? "final_message_run"
                  : "full_text",
              onProgress: (event) => {
                progress.phase = event.phase;
              },
            }),
        });
        rawReply = await handleAssistantFileActions({
          rawReply,
          config: this.options.config,
          client,
          database: this.options.database,
          session: sessionForReply,
          role: route.role,
        });
      } catch (error) {
        console.error("[worker] codex reply failed", error);
        rawReply = buildCodexErrorReply({
          error,
          role: route.role,
          codexCommand: this.options.config.codex[route.role].command,
        });
      }
    }

    const replyText =
      route.role === "family"
        ? filterFamilyOutput(rawReply, this.options.config.familyPolicy)
        : rawReply;
    const finalReplyText = [dayChangeNotice, replyText].filter(Boolean).join("\n");

    if (!finalReplyText.trim()) {
      return;
    }

    let lastClientId = "";
    const chunks = splitReplyText(
      finalReplyText,
      this.options.config.wechat.replyChunkChars,
    );
    for (const [index, chunk] of chunks.entries()) {
      lastClientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: chunk,
      });
      if (index < chunks.length - 1) {
        await sleep(350);
      }
    }

    this.options.database.appendMessage({
      id: buildMessageId("outbound"),
      sessionId: sessionForReply.id,
      direction: "outbound",
      messageType: "text",
      textContent: finalReplyText,
      createdAt: new Date().toISOString(),
      sourceMessageId: lastClientId || inbound.sourceMessageId,
    });
    const latestMemory = parseSessionMemory(sessionForReply.memoryJson);
    this.options.database.saveSession({
      id: sessionForReply.id,
      wechatAccountId: sessionForReply.wechatAccountId,
      contactId: sessionForReply.contactId,
      role: route.role,
      status: sessionForReply.status,
      summaryText: sessionForReply.summaryText,
      memoryJson: stringifySessionMemory({
        ...latestMemory,
        turnCount:
          Math.max(latestMemory.turnCount ?? 0, sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          Math.max(
            latestMemory.estimatedTokenCount ?? 0,
            sessionMemory.estimatedTokenCount ?? 0,
          ) +
          estimateTextTokens(userTextForCodex) +
          estimateTextTokens(finalReplyText),
      }),
      contextToken: sessionForReply.contextToken,
      lastActiveAt: new Date().toISOString(),
    });
  }
}
