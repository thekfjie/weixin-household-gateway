import { FamilyPolicyConfig } from "../config/types.js";

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").trim();
}

function stripPathLikeText(text: string): string {
  return text.replace(/[A-Za-z]:\\[^\s]+|\/[A-Za-z0-9._/-]+/g, "[path omitted]");
}

function stripShellCommands(text: string): string {
  return text.replace(/^\s*(sudo|rm|mv|cp|chmod|chown|systemctl|journalctl)\b.*$/gim, "");
}

function stripReasoningLikeText(text: string): string {
  return text
    .replace(/^(?:\u601d\u8003\u8fc7\u7a0b|reasoning|analysis)[:\uff1a].*$/gim, "")
    .replace(/^(?:\u63a8\u7406|thoughts?)[:\uff1a].*$/gim, "")
    .replace(/^(?:\u5206\u6790|internal note)[:\uff1a].*$/gim, "");
}

const CODEX_MODEL_METADATA_WARNING_LINE =
  /^(?:Warning:\s*)?Model metadata for [`'"]?[^`'\"\n]+[`'"]? not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*$/gim;

export function stripCodexRuntimeNoise(text: string): string {
  const withoutWarnings = text.replace(CODEX_MODEL_METADATA_WARNING_LINE, "");
  if (withoutWarnings === text) {
    return text;
  }
  return withoutWarnings.replace(/\n{3,}/g, "\n\n").trim();
}

export function filterFamilyOutput(
  text: string,
  policy: FamilyPolicyConfig,
): string {
  const keepPermissionDiagnostics =
    /blocked execute outside controlled workspace|blocked (?:read|write|edit|move|delete) outside controlled workspace|no safe path scope detected|usage_limit_exceeded|usage limit|OPENAI_API_KEY|CODEX_API_KEY|authenticate/i.test(
      text,
    );
  let next = stripCodexRuntimeNoise(text).trim();

  if (policy.stripReasoning) {
    next = stripReasoningLikeText(next);
  }

  if (policy.stripCommands && !keepPermissionDiagnostics) {
    next = stripShellCommands(next);
    next = stripCodeFences(next);
  }

  if (policy.stripPaths && !keepPermissionDiagnostics) {
    next = stripPathLikeText(next);
  }

  return next.replace(/\n{3,}/g, "\n\n").trim();
}
