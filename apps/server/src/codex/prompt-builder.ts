import { buildPreviousSessionHint } from "../commands/index.js";
import { AppConfig, UserRole } from "../config/types.js";
import {
  buildPromptContext,
  buildCrossDayNotice,
  buildSessionWorkspacePaths,
  buildSessionWorkspacePromptBlock,
  parseSessionMemory,
} from "../sessions/index.js";
import { AppDatabase, SessionRecord } from "../storage/index.js";

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
      : [
          "前置信息：当前路由是 family。",
          "如果要把处理好的成品文件发回给用户，只能发送当前会话 outbox 里的文件。",
          "当你已经把成品写入 outbox 后，可以只输出动作标记：[[send_file path=\"/absolute/path\" caption=\"可选说明\"]]。",
        ].join("\n");
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

export function buildCodexPromptSet(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
  persistentContext: boolean;
}): {
  prompt: string;
  bootstrapPrompt?: string;
  additionalDirectories: string[];
  readOnlyDirectories: string[];
} {
  const workspacePaths = buildSessionWorkspacePaths({
    config: params.config,
    sessionId: params.session.id,
  });
  const prompt = params.persistentContext
    ? buildCodexIncrementalPrompt(params)
    : buildCodexBootstrapPrompt(params);
  const bootstrapPrompt = params.persistentContext
    ? buildCodexBootstrapPrompt(params)
    : undefined;

  return {
    prompt,
    ...(bootstrapPrompt ? { bootstrapPrompt } : {}),
    additionalDirectories: Object.values(workspacePaths),
    readOnlyDirectories: [workspacePaths.inboxDir],
  };
}
