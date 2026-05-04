import fs from "node:fs";
import path from "node:path";
import { AppConfig, UserRole } from "../config/types.js";
import { SessionRecord } from "../storage/index.js";

export interface SessionWorkspacePaths {
  inboxDir: string;
  officeDir: string;
  outboxDir: string;
}

export function buildSessionWorkspacePaths(params: {
  config: AppConfig;
  sessionId: string;
}): SessionWorkspacePaths {
  return {
    inboxDir: path.join(params.config.server.dataDir, "inbox", params.sessionId),
    officeDir: path.join(params.config.server.dataDir, "office", params.sessionId),
    outboxDir: path.join(params.config.server.dataDir, "outbox", params.sessionId),
  };
}

export function ensureSessionWorkspaceDirs(params: {
  config: AppConfig;
  sessionId: string;
}): void {
  const paths = buildSessionWorkspacePaths(params);
  for (const directory of Object.values(paths)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function buildSessionWorkspacePromptBlock(params: {
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
