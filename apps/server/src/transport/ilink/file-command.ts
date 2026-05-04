import fs from "node:fs";
import path from "node:path";
import {
  parseAssistantFileAction,
  type ParsedCommand,
} from "../../commands/index.js";
import { AppConfig, UserRole } from "../../config/types.js";
import {
  assertFileAllowedForWechatCommand,
  isInsideDirectory,
  sendLocalFileToSession,
} from "../../files/index.js";
import { buildSessionWorkspacePaths } from "../../sessions/index.js";
import { AppDatabase, SessionRecord } from "../../storage/index.js";
import { ILinkApiClient } from "./api-client.js";
import { formatBytes } from "./reply.js";

export async function handleFileCommand(params: {
  command: ParsedCommand;
  config: AppConfig;
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  role: UserRole;
}): Promise<string> {
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

  if (params.role === "family") {
    const { outboxDir } = buildSessionWorkspacePaths({
      config: params.config,
      sessionId: params.session.id,
    });
    if (!isInsideDirectory(filePath, outboxDir)) {
      return [
        "family 当前只允许回传本次会话 outbox 里的成品文件。",
        `当前会话 outbox：${outboxDir}`,
        "如果你想让我把处理好的文件发回来，请先让我把成品写到 outbox，再让我发送。",
      ].join("\n");
    }
  } else {
    assertFileAllowedForWechatCommand(filePath, params.config.fileSend);
  }

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

export async function handleAssistantFileActions(params: {
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
