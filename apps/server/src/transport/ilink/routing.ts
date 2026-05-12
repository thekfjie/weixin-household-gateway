import { PendingInboundAttachment } from "../../sessions/index.js";

export interface FamilyBackendDecision {
  backend: "api" | "acp";
  reason:
    | "plain_text"
    | "image_only"
    | "simple_text_attachment"
    | "file_operation"
    | "command_execution"
    | "artifact_generation"
    | "complex_attachment"
    | "explicit_admin_work";
}

const ACP_COMMAND_PATTERNS = [
  /\b(cmd|command|shell|powershell|bash|terminal)\b/i,
  /\b(sudo|systemctl|service|journalctl|docker|kubectl|ssh|scp|rsync)\b/i,
  /运行命令|执行命令|帮我跑一下|到服务器上|去机器上/i,
];

const ACP_FILE_OPERATION_PATTERNS = [
  /修改文件|编辑文件|改配置|改代码|工作区|本地文件|服务器文件|项目目录|仓库里/i,
  /打开.*文件|把.*写进|保存成文件|发回文件|导出文件/i,
];

const ACP_ARTIFACT_PATTERNS = [
  /生成ppt|制作ppt|做个ppt|做个表格|生成文档|生成文件|导出表格|整理成成品/i,
];

const SIMPLE_TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
]);

const COMPLEX_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".rar",
  ".7z",
]);

function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index < 0) {
    return "";
  }

  return fileName.slice(index).toLowerCase();
}

function hasPattern(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasComplexAttachment(
  attachments: PendingInboundAttachment[],
): boolean {
  return attachments.some((attachment) => {
    if (attachment.kind === "image") {
      return false;
    }

    return COMPLEX_ATTACHMENT_EXTENSIONS.has(getExtension(attachment.fileName));
  });
}

function hasSimpleTextOnlyAttachments(
  attachments: PendingInboundAttachment[],
): boolean {
  if (attachments.length === 0) {
    return false;
  }

  return attachments.every((attachment) => {
    if (attachment.kind === "image") {
      return false;
    }

    return SIMPLE_TEXT_ATTACHMENT_EXTENSIONS.has(getExtension(attachment.fileName));
  });
}

export function decideFamilyBackend(params: {
  userText: string;
  attachments: PendingInboundAttachment[];
}): FamilyBackendDecision {
  const normalizedText = params.userText.trim();

  if (hasPattern(ACP_COMMAND_PATTERNS, normalizedText)) {
    return {
      backend: "acp",
      reason:
        /\b(sudo|systemctl|service|journalctl|docker|kubectl|ssh|scp|rsync)\b/i.test(
          normalizedText,
        )
          ? "explicit_admin_work"
          : "command_execution",
    };
  }

  if (hasPattern(ACP_ARTIFACT_PATTERNS, normalizedText)) {
    return {
      backend: "acp",
      reason: "artifact_generation",
    };
  }

  if (hasPattern(ACP_FILE_OPERATION_PATTERNS, normalizedText)) {
    return {
      backend: "acp",
      reason: "file_operation",
    };
  }

  if (params.attachments.length === 0) {
    return {
      backend: "api",
      reason: "plain_text",
    };
  }

  if (
    params.attachments.every(
      (attachment) =>
        attachment.kind === "image" && attachment.downloadStatus === "ready",
    )
  ) {
    return {
      backend: "api",
      reason: "image_only",
    };
  }

  if (hasSimpleTextOnlyAttachments(params.attachments)) {
    return {
      backend: "api",
      reason: "simple_text_attachment",
    };
  }

  if (hasComplexAttachment(params.attachments)) {
    return {
      backend: "acp",
      reason: "complex_attachment",
    };
  }

  return {
    backend: "acp",
    reason: "complex_attachment",
  };
}
