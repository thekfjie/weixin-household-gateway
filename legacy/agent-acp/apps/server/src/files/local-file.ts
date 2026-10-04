import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FileSendConfig } from "../config/types.js";
import { AppDatabase, SessionRecord } from "../storage/index.js";
import { ILinkApiClient } from "../transport/ilink/api-client.js";
import {
  sendUploadedFileMessage,
  uploadLocalMedia,
  UploadedIlinkMedia,
} from "../transport/ilink/media.js";

export interface LocalFileSendResult {
  clientId: string;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  plaintextMd5: string;
  uploaded: UploadedIlinkMedia;
}

function createClientId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };

  return known[extension] ?? "application/octet-stream";
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function formatAllowedDirs(allowedDirs: string[]): string {
  return allowedDirs.length > 0 ? allowedDirs.join(", ") : "(none)";
}

export function assertFileAllowedForWechatCommand(
  filePath: string,
  policy: FileSendConfig,
): void {
  const realFilePath = fs.realpathSync(filePath);
  const allowedDirs = policy.allowedDirs
    .filter((directory) => fs.existsSync(directory))
    .map((directory) => fs.realpathSync(directory));

  if (
    !allowedDirs.some((directory) =>
      isInsideDirectory(realFilePath, directory),
    )
  ) {
    throw new Error(
      `文件不在允许发送目录内。允许目录：${formatAllowedDirs(policy.allowedDirs)}`,
    );
  }
}

export async function sendLocalFileToSession(params: {
  client: ILinkApiClient;
  database: AppDatabase;
  session: SessionRecord;
  filePath: string;
  caption?: string;
}): Promise<LocalFileSendResult> {
  const filePath = path.resolve(params.filePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是普通文件：${filePath}`);
  }

  const attachmentId = createClientId("attachment");
  params.database.saveAttachment({
    id: attachmentId,
    sessionId: params.session.id,
    localPath: filePath,
    mimeType: inferMimeType(filePath),
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
    outboundStatus: "uploading",
  });

  try {
    const uploaded = await uploadLocalMedia({
      client: params.client,
      filePath,
      toUserId: params.session.contactId,
    });
    const clientId = await sendUploadedFileMessage({
      client: params.client,
      toUserId: params.session.contactId,
      contextToken: params.session.contextToken,
      uploaded,
      ...(params.caption ? { caption: params.caption } : {}),
    });

    params.database.updateAttachmentStatus(attachmentId, "sent");
    params.database.appendMessage({
      id: createClientId("outbound-file"),
      sessionId: params.session.id,
      direction: "outbound",
      messageType: "file",
      filePath,
      createdAt: new Date().toISOString(),
      sourceMessageId: clientId,
    });

    return {
      clientId,
      filePath,
      fileName: path.basename(filePath),
      sizeBytes: stat.size,
      plaintextMd5: uploaded.plaintextMd5,
      uploaded,
    };
  } catch (error) {
    params.database.updateAttachmentStatus(attachmentId, "failed");
    throw error;
  }
}
