import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppConfig, UserRole } from "../../config/types.js";
import { inferMimeType } from "../../files/index.js";
import type { PendingInboundAttachment } from "../../sessions/index.js";
import { AppDatabase, SessionRecord } from "../../storage/index.js";
import { ILinkApiClient } from "./api-client.js";
import { NormalizedInboundAttachment } from "./inbound.js";
import { downloadEncryptedMediaFromCdn } from "./media.js";
import { formatBytes } from "./reply.js";

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function sanitizeFileName(fileName: string): string {
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

export function buildAttachmentPromptBlock(
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

export function buildMediaAckReply(params: {
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

export function buildInboundAttachmentAckPlaceholders(
  attachments: NormalizedInboundAttachment[],
): Array<{
  fileName: string;
}> {
  return attachments.map((attachment) => ({
    fileName: sanitizeFileName(attachment.fileName),
  }));
}

export async function downloadInboundAttachments(params: {
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
