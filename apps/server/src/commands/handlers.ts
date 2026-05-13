import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AppConfig,
  UserRole,
} from "../config/types.js";
import { isCodexReasoningEffort } from "../config/reasoning.js";
import { AppDatabase, SessionRecord, WechatAccountRecord } from "../storage/index.js";
import {
  formatBeijingTime,
  buildSessionId,
  buildSessionWorkspacePaths,
  stringifySessionMemory,
  buildDeterministicSessionSummary,
  summarizeCarryoverContext,
  summarizeRecentMessagesInline,
} from "../sessions/index.js";
import type { SessionMemoryState } from "../sessions/index.js";
import type { ParsedCommand } from "./types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export function findPreviousSession(params: {
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

export function findYesterdaySession(params: {
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

function listFilesForReply(directory: string, maxDepth: number): string[] {
  const files: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [
    { directory, depth: 0 },
  ];

  while (stack.length > 0 && files.length < 200) {
    const current = stack.pop();
    if (!current) break;

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
      if (files.length >= 200) break;
    }
  }

  return files;
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
    return formatCodexRoleSettings({ database: params.database, role: targetRole });
  }

  if (action === "reset") {
    params.database.saveCodexRoleSettings({ role: targetRole, model: "", reasoningEffort: "" });
    params.onChanged?.(targetRole);
    return `已重置 ${targetRole} 的 Codex 配置。\n已刷新对应后端；后续该角色会回到默认配置。`;
  }

  if (action === "model") {
    const model = params.command.args[2]?.trim();
    if (!model) return "用法：/codex admin|family model <模型名>";
    const current = params.database.getCodexRoleSettings(targetRole);
    params.database.saveCodexRoleSettings({
      role: targetRole,
      model,
      ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    });
    params.onChanged?.(targetRole);
    return `已设置 ${targetRole} 模型：${model}\n已刷新对应后端；后续该角色会按新模型运行。`;
  }

  if (action === "reasoning") {
    const reasoning = params.command.args[2]?.trim().toLowerCase();
    if (!reasoning || !isCodexReasoningEffort(reasoning)) {
      return "用法：/codex admin|family reasoning low|medium|high|xhigh";
    }
    const current = params.database.getCodexRoleSettings(targetRole);
    params.database.saveCodexRoleSettings({
      role: targetRole,
      ...(current?.model ? { model: current.model } : {}),
      reasoningEffort: reasoning,
    });
    params.onChanged?.(targetRole);
    return `已设置 ${targetRole} 思考强度：${reasoning}\n已刷新对应后端；后续该角色会按新思考强度运行。`;
  }

  return "用法：/codex admin|family [model <模型>|reasoning <low|medium|high|xhigh>|reset]";
}

function formatSwitch(value: boolean): string {
  return value ? "on" : "off";
}

function parseSwitch(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["on", "true", "1", "开", "开启", "打开"].includes(normalized)) {
    return true;
  }

  if (["off", "false", "0", "关", "关闭"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function resolveProgressDefault(params: {
  config: AppConfig;
  role: UserRole;
}): boolean {
  return params.role === "admin"
    ? params.config.wechat.adminProgressEnabled
    : params.config.wechat.familyProgressEnabled;
}

function buildOutputSettingsReply(params: {
  command: ParsedCommand;
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  sessionMemory: SessionMemoryState;
}): string {
  const progressEnabled =
    params.sessionMemory.outputProgressEnabled ??
    resolveProgressDefault({
      config: params.config,
      role: params.role,
    });
  const familyApiStreamingEnabled =
    params.sessionMemory.familyApiStreamingEnabled ??
    params.config.wechat.familyApiStreamingEnabled;

  const target = params.command.args[0]?.trim().toLowerCase();
  if (!target) {
    const lines = [
      "当前输出设置：",
      `process=${formatSwitch(progressEnabled)}`,
    ];
    if (params.role === "family") {
      lines.push(`family-api-stream=${formatSwitch(familyApiStreamingEnabled)}`);
    }
    lines.push(
      "",
      "用法：",
      "/output process on|off",
      params.role === "family" ? "/output family-api-stream on|off" : "",
    );
    return lines.filter((line) => line !== "").join("\n");
  }

  if (target !== "process" && target !== "family-api-stream") {
    return "用法：/output process on|off 或 /output family-api-stream on|off";
  }

  if (target === "family-api-stream" && params.role !== "family") {
    return "family-api-stream 只影响 family 的直连 API 早发。";
  }

  const enabled = parseSwitch(params.command.args[1]);
  if (enabled === undefined) {
    return "用法：/output process on|off 或 /output family-api-stream on|off";
  }

  const nextMemory =
    target === "process"
      ? {
          ...params.sessionMemory,
          outputProgressEnabled: enabled,
        }
      : {
          ...params.sessionMemory,
          familyApiStreamingEnabled: enabled,
        };
  params.database.saveSession({
    id: params.session.id,
    wechatAccountId: params.session.wechatAccountId,
    contactId: params.session.contactId,
    role: params.session.role,
    status: params.session.status,
    summaryText: params.session.summaryText,
    memoryJson: stringifySessionMemory(nextMemory),
    contextToken: params.session.contextToken,
    lastActiveAt: params.session.lastActiveAt,
  });

  return target === "process"
    ? `过程输出已${enabled ? "开启" : "关闭"}。`
    : `family API 早发已${enabled ? "开启" : "关闭"}。`;
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
  if (sessions.length === 0) return "当前还没有会话。";

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
  session?: SessionRecord;
}): string {
  if (params.role === "family") {
    if (!params.session) return "当前会话还没有可回传的成品文件。";
    const { outboxDir } = buildSessionWorkspacePaths({
      config: params.config,
      sessionId: params.session.id,
    });
    const files = fs.existsSync(outboxDir) ? listFilesForReply(outboxDir, 2) : [];
    if (files.length === 0) {
      return `当前会话 outbox 里还没有可回传的成品文件。\noutbox：${outboxDir}`;
    }
    return ["当前会话可回传文件：", ...files.slice(0, 10)].join("\n");
  }

  if (params.role !== "admin") return "这个文件命令暂时不可用。";

  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  for (const directory of params.config.fileSend.allowedDirs) {
    if (!fs.existsSync(directory)) continue;
    for (const filePath of listFilesForReply(directory, 2)) {
      const stat = fs.statSync(filePath);
      if (stat.size > params.config.fileSend.maxBytes) continue;
      files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const recent = files.slice(0, 10);
  if (recent.length === 0) {
    return `白名单目录里暂时没有可发送文件。\n允许目录：${params.config.fileSend.allowedDirs.join(", ")}`;
  }

  return [
    "最近可发送文件：",
    ...recent.map((file) => `${file.filePath}  ${formatBytes(file.size)}`),
  ].join("\n");
}

export function buildCommandReply(params: {
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
            "/new 开启新话题，/reset /clear 彻底清空当前对话",
            "/file <文件路径> [说明] 发送允许目录里的服务器文件",
            "/files 查看最近可发送文件",
            "/accounts 查看已绑定微信账号",
            "/codex 查看或修改 admin/family 的模型与思考强度",
            "/output 查看或切换过程输出",
          ].join("\n")
        : [
            "可用命令：",
            "/time 查看北京时间",
            "/whoami 查看当前账号角色",
            "/mode 查看当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/new 开启新话题，/reset /clear 彻底清空当前对话",
            "/file <outbox文件路径> [说明] 回传当前会话产出的成品文件",
            "/output 查看或切换过程输出",
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
    case "/output":
      return buildOutputSettingsReply({
        command: params.command,
        config: params.config,
        database: params.database,
        role: params.role,
        session: params.session,
        sessionMemory: params.sessionMemory,
      });
    case "/files":
      return buildFilesReply({
        config: params.config,
        role: params.role,
        session: params.session,
      });
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
        parts.push(`carryover_session=${params.sessionMemory.carryoverSourceSessionId}`);
      }
      if (params.sessionMemory.carryoverSourceLastActiveAt) {
        parts.push(`carryover_last=${params.sessionMemory.carryoverSourceLastActiveAt}`);
      }
      if (params.sessionMemory.carryoverSummary?.trim()) {
        parts.push(`carryover_summary=${params.sessionMemory.carryoverSummary}`);
      }
      if (params.sessionMemory.familyApiContext?.trim()) {
        parts.push(`family_api_context_chars=${params.sessionMemory.familyApiContext.length}`);
      }
      if (params.sessionMemory.lastAcpTaskNote?.trim()) {
        parts.push(`last_acp_task_note_chars=${params.sessionMemory.lastAcpTaskNote.length}`);
      }
      if (params.sessionMemory.lastFamilyBackend) {
        parts.push(`last_family_backend=${params.sessionMemory.lastFamilyBackend}`);
      }
      if (params.sessionMemory.lastFamilyBackendReason) {
        parts.push(`last_family_backend_reason=${params.sessionMemory.lastFamilyBackendReason}`);
      }
      return `当前 memory：\n${parts.join("\n")}`;
    }
    case "/last": {
      const previous = findPreviousSession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `上一段对话：\n${formatSessionSnapshot({ session: previous, database: params.database })}`
        : "当前还没有上一段对话。";
    }
    case "/yesterday": {
      const previous = findYesterdaySession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `昨天的上一段对话：\n${formatSessionSnapshot({ session: previous, database: params.database })}`
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
      const isHardClear = params.command.name !== "/new" || params.role !== "family";
      const recentMessagesForCarryover = params.database
        .listSessionMessages(params.session.id, 12)
        .reverse();
      const archivedSummary =
        buildDeterministicSessionSummary({
          session: params.session,
          recentMessages: recentMessagesForCarryover,
        }) || params.session.summaryText;
      const carryoverSummary = isHardClear
        ? ""
        : summarizeCarryoverContext({
            session: params.session,
            recentMessages: recentMessagesForCarryover,
          });
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.session.role,
        status: "archived",
        summaryText: archivedSummary,
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
        summaryText: isHardClear ? "" : archivedSummary,
        memoryJson: stringifySessionMemory({
          ...(params.sessionMemory.routeMode && !isHardClear
            ? { routeMode: params.sessionMemory.routeMode }
            : {}),
          ...(carryoverSummary
            ? {
                carryoverSummary,
                carryoverSourceSessionId: params.session.id,
                carryoverSourceLastActiveAt: params.session.lastActiveAt,
              }
            : {}),
        }),
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      return isHardClear
        ? "当前对话已经彻底清空，并且已经切到一个新的会话。我们可以重新开始。"
        : "已经开启新话题；我会保留一点上一段的轻量上下文，避免突然断片。要彻底清空请发 /reset 或 /clear。";
    }
    default:
      return "暂不支持这个内建命令。";
  }
}
