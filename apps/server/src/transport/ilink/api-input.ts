import fs from "node:fs";
import { inferMimeType } from "../../files/index.js";
import { CodexInputPart } from "../../codex/index.js";
import { PendingInboundAttachment } from "../../sessions/index.js";
import { SessionRecord } from "../../storage/index.js";
import { buildFamilyApiContextBlock } from "./conversation-context.js";

const MAX_ATTACHMENT_TEXT_CHARS = 8_000;

function normalizeText(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

function readAttachmentText(localPath: string): string {
  return normalizeText(fs.readFileSync(localPath, "utf8"));
}

function buildAttachmentTextBlock(
  attachments: PendingInboundAttachment[],
): string | undefined {
  const blocks: string[] = [];

  for (const attachment of attachments) {
    if (
      attachment.kind !== "file" ||
      attachment.downloadStatus !== "ready" ||
      !attachment.localPath
    ) {
      continue;
    }

    try {
      const content = readAttachmentText(attachment.localPath);
      if (!content) {
        continue;
      }

      const trimmed =
        content.length > MAX_ATTACHMENT_TEXT_CHARS
          ? `${content.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n[truncated]`
          : content;
      blocks.push(
        [
          `Attachment: ${attachment.fileName}`,
          "Content:",
          trimmed,
        ].join("\n"),
      );
    } catch (error) {
      blocks.push(
        `Attachment: ${attachment.fileName}\nRead failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (blocks.length === 0) {
    return undefined;
  }

  return blocks.join("\n\n");
}

export function buildApiInputParts(params: {
  session: SessionRecord;
  userText: string;
  attachments: PendingInboundAttachment[];
}): CodexInputPart[] {
  const parts: CodexInputPart[] = [];
  const attachmentTextBlock = buildAttachmentTextBlock(params.attachments);
  const contextBlock = buildFamilyApiContextBlock({
    session: params.session,
  });
  if (contextBlock) {
    parts.push({
      type: "text",
      text: contextBlock,
    });
  }

  const normalizedUserText = normalizeText(params.userText);
  if (normalizedUserText) {
    parts.push({
      type: "text",
      text: normalizedUserText,
    });
  }

  if (attachmentTextBlock) {
    parts.push({
      type: "text",
      text: attachmentTextBlock,
    });
  }

  for (const attachment of params.attachments) {
    if (
      attachment.kind !== "image" ||
      attachment.downloadStatus !== "ready" ||
      !attachment.localPath
    ) {
      continue;
    }

    parts.push({
      type: "image",
      filePath: attachment.localPath,
      mimeType: inferMimeType(attachment.localPath),
    });
  }

  return parts;
}
