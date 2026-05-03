import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AppConfig,
  CodexReasoningEffort,
  UserRole,
} from "../../config/types.js";
import {
  ParsedCommand,
  parseBuiltInCommand,
  parseNaturalFileRequest,
  parseAssistantFileAction,
  detectPreviousSessionReference,
} from "../../commands/index.js";
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
  buildSessionId,
  buildPromptContext,
  ensureActiveSession,
  formatBeijingTime,
  shouldRotateSession,
  parseSessionMemory,
  stringifySessionMemory,
  estimateTextTokens,
  isNewBeijingCalendarDay,
  shouldRotateByThresholds,
  buildDayChangeUserNotice,
  buildCrossDayNotice,
  summarizeRecentMessagesInline,
  summarizeCarryoverContext,
  buildDeterministicSessionSummary,
} from "../../sessions/index.js";
import type {
  SessionMemoryState,
  PendingInboundAttachment,
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
import {
  splitReplyText,
  buildCodexErrorReply,
  buildCommandErrorReply,
  buildThinkingNoticeText,
  formatBytes,
} from "./reply.js";
import { withTypingIndicator } from "./typing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReasoningEffort(value: string): value is CodexReasoningEffort {
  return ["low", "medium", "high", "xhigh"].includes(value);
}

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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
  onCodexSettingsChanged?: (role: UserRole) => void;
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
            "/new /reset /clear 清空当前对话并开启新会话",
            "/file <文件路径> [说明] 发送允许目录里的服务器文件",
            "/files 查看最近可发送文件",
            "/accounts 查看已绑定微信账号",
            "/codex 查看或修改 admin/family 的模型与思考强度",
          ].join("\n")
        : [
            "可用命令：",
            "/time 查看北京时间",
            "/whoami 查看当前账号角色",
            "/mode 查看当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/new /reset /clear 清空当前对话并开启新会话",
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
    case "/codex":
      return buildCodexSettingsReply({
        database: params.database,
        role: params.role,
        command: params.command,
        ...(params.onCodexSettingsChanged
          ? { onChanged: params.onCodexSettingsChanged }
          : {}),
      });
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
    case "/clear": {
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.session.role,
        status: "archived",
        summaryText: params.session.summaryText,
        memoryJson: params.session.memoryJson,
        contextToken: params.session.contextToken,
        lastActiveAt: params.session.lastActiveAt,
      });

      const nextSessionId = buildSessionId(
        params.session.wechatAccountId,
        params.session.contactId,
        crypto.randomUUID(),
      );

      params.database.saveSession({
        id: nextSessionId,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.accountRole,
        status: "active",
        summaryText: "",
        memoryJson: stringifySessionMemory({}),
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      return "当前对话已经清空，并且已经切到一个新的会话。我们可以重新开始。";
    }
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

function formatCodexRoleSettings(params: {
  database: AppDatabase;
  role: UserRole;
}): string {
  const settings = params.database.getCodexRoleSettings(params.role);
  return [
    `role=${params.role}`,
    `model=${settings?.model ?? "(default)"}`,
    `reasoning=${settings?.reasoningEffort ?? "(default)"}`,
  ].join("\n");
}

function buildCodexSettingsReply(params: {
  database: AppDatabase;
  role: UserRole;
  command: ParsedCommand;
  onChanged?: (role: UserRole) => void;
}): string {
  if (params.role !== "admin") {
    return "这个命令只对 admin 开放。";
  }

  const roleArg = params.command.args[0]?.trim().toLowerCase();
  if (!roleArg) {
    return [
      "当前 Codex 角色配置：",
      formatCodexRoleSettings({ database: params.database, role: "admin" }),
      "",
      formatCodexRoleSettings({ database: params.database, role: "family" }),
      "",
      "用法示例：",
      "/codex admin",
      "/codex family",
      "/codex admin model gpt-5.5",
      "/codex family reasoning high",
      "/codex admin reset",
    ].join("\n");
  }

  if (roleArg !== "admin" && roleArg !== "family") {
    return "用法：/codex admin|family [model <模型>|reasoning <low|medium|high|xhigh>|reset]";
  }

  const targetRole = roleArg as UserRole;
  const action = params.command.args[1]?.trim().toLowerCase();
  if (!action) {
    return formatCodexRoleSettings({
      database: params.database,
      role: targetRole,
    });
  }

  if (action === "reset") {
    params.database.saveCodexRoleSettings({
      role: targetRole,
      model: "",
      reasoningEffort: "",
    });
    params.onChanged?.(targetRole);
    return [
      `已重置 ${targetRole} 的 Codex 配置。`,
      "已刷新对应后端；后续该角色会回到默认配置。",
    ].join("\n");
  }

  if (action === "model") {
    const model = params.command.args[2]?.trim();
    if (!model) {
      return "用法：/codex admin|family model <模型名>";
    }

    const current = params.database.getCodexRoleSettings(targetRole);
    params.database.saveCodexRoleSettings({
      role: targetRole,
      model,
      ...(current?.reasoningEffort
        ? { reasoningEffort: current.reasoningEffort }
        : {}),
    });
    params.onChanged?.(targetRole);
    return [
      `已设置 ${targetRole} 模型：${model}`,
      "已刷新对应后端；后续该角色会按新模型运行。",
    ].join("\n");
  }

  if (action === "reasoning") {
    const reasoning = params.command.args[2]?.trim().toLowerCase();
    if (!reasoning || !isReasoningEffort(reasoning)) {
      return "用法：/codex admin|family reasoning low|medium|high|xhigh";
    }

    const current = params.database.getCodexRoleSettings(targetRole);
    params.database.saveCodexRoleSettings({
      role: targetRole,
      ...(current?.model ? { model: current.model } : {}),
      reasoningEffort: reasoning,
    });
    params.onChanged?.(targetRole);
    return [
      `已设置 ${targetRole} 思考强度：${reasoning}`,
      "已刷新对应后端；后续该角色会按新思考强度运行。",
    ].join("\n");
  }

  return "用法：/codex admin|family [model <模型>|reasoning <low|medium|high|xhigh>|reset]";
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
    "当前会话工作区：",
    `- inbox: ${paths.inboxDir}`,
    `- office: ${paths.officeDir}`,
    `- outbox: ${paths.outboxDir}`,
    "尽量只在这三个目录里处理当前会话文件。",
    "如需发回成品文件，请写入 outbox，并只输出：[[send_file path=\"/absolute/path\" caption=\"可选说明\"]]。",
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
  attachments: Array<{
    fileName: string;
    downloadStatus?: "ready" | "failed";
    errorMessage?: string;
  }>;
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

function buildInboundAttachmentAckPlaceholders(
  attachments: NormalizedInboundAttachment[],
): Array<{
  fileName: string;
}> {
  return attachments.map((attachment) => ({
    fileName: sanitizeFileName(attachment.fileName),
  }));
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
  const workspacePaths = buildSessionWorkspacePaths({
    config: params.config,
    sessionId: params.session.id,
  });
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
    additionalDirectories: Object.values(workspacePaths),
    readOnlyDirectories: [workspacePaths.inboxDir],
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

export interface WechatWorkerOptions {
  config: AppConfig;
  database: AppDatabase;
}

export class WechatWorker {
  private running = false;

  private loopPromise: Promise<void> | undefined;

  private codexBackends: Record<UserRole, CodexBackend>;

  constructor(private readonly options: WechatWorkerOptions) {
    this.codexBackends = {
      admin: createCodexBackend(
        this.buildRuntimeCodexConfig("admin"),
      ),
      family: createCodexBackend(
        this.buildRuntimeCodexConfig("family"),
      ),
    };
  }

  private buildRuntimeCodexConfig(role: UserRole) {
    const baseConfig = this.options.config.codex[role];
    const settings = this.options.database.getCodexRoleSettings(role);
    return {
      ...baseConfig,
      ...(settings?.model || settings?.reasoningEffort
        ? {
            roleOverrides: {
              ...(settings?.model ? { model: settings.model } : {}),
              ...(settings?.reasoningEffort &&
              isReasoningEffort(settings.reasoningEffort)
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
            },
          }
        : {}),
    };
  }

  private rebuildCodexBackend(role: UserRole): void {
    this.codexBackends[role].dispose();
    this.codexBackends[role] = createCodexBackend(
      this.buildRuntimeCodexConfig(role),
    );
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
    if (inbound.attachments.length > 0 && !inbound.text.trim()) {
      const ack = buildMediaAckReply({
        role: route.role,
        attachments: buildInboundAttachmentAckPlaceholders(inbound.attachments),
      });
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: ack,
      });
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: ack,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
    }
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
      if (downloadedAttachments.some((attachment) => attachment.downloadStatus === "failed")) {
        const failureAck = buildMediaAckReply({
          role: route.role,
          attachments: downloadedAttachments,
        });
        const clientId = await sendTextMessage({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          text: failureAck,
        });
        this.options.database.appendMessage({
          id: buildMessageId("outbound"),
          sessionId: nextSession.id,
          direction: "outbound",
          messageType: "text",
          textContent: failureAck,
          createdAt: new Date().toISOString(),
          sourceMessageId: clientId || inbound.sourceMessageId,
        });
      }
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
        if (
          parsedCommand.name === "/new" ||
          parsedCommand.name === "/reset" ||
          parsedCommand.name === "/clear"
        ) {
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
                onCodexSettingsChanged: (changedRole) => {
                  this.rebuildCodexBackend(changedRole);
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
            accountRole: accountRoute.role,
            sessionMode: sessionMemory.routeMode,
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
