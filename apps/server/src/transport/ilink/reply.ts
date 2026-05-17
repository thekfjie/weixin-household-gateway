import { UserRole } from "../../config/types.js";
import { errorToRedactedMessage } from "../../policy/index.js";

const CONTEXT_COMPACTED_NOTICE_PATTERN =
  /Context compacted\s+Heads up:\s+Long threads and multiple compactions can cause the model to be less accurate\.\s+Start a new thread when possible to keep threads small and targeted\./gi;

function normalizeContextCompactedNotice(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(
      /^Context compacted Heads up:/i,
      "Context compacted\nHeads up:",
    )
    .trim();
}

function splitSystemNoticeRuns(text: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  CONTEXT_COMPACTED_NOTICE_PATTERN.lastIndex = 0;

  for (
    let match = CONTEXT_COMPACTED_NOTICE_PATTERN.exec(text);
    match;
    match = CONTEXT_COMPACTED_NOTICE_PATTERN.exec(text)
  ) {
    const before = text.slice(cursor, match.index).trim();
    if (before) {
      parts.push(before);
    }
    parts.push(normalizeContextCompactedNotice(match[0] ?? ""));
    cursor = match.index + match[0].length;
  }

  const after = text.slice(cursor).trim();
  if (after) {
    parts.push(after);
  }

  return parts.length > 0 ? parts : [text.trim()].filter(Boolean);
}

function splitByLength(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const cutAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" "),
    );
    const end = cutAt > Math.floor(maxChars * 0.45) ? cutAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

export function splitReplyText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  return splitSystemNoticeRuns(trimmed).flatMap((part) =>
    splitByLength(part, maxChars),
  );
}

export function splitReplyTextBySystemNotice(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  return splitSystemNoticeRuns(trimmed);
}

export function buildCodexErrorReply(params: {
  error: unknown;
  role: UserRole;
  accountRole?: UserRole | undefined;
  sessionMode?: UserRole | undefined;
  codexCommand?: string;
}): string {
  const message = errorToRedactedMessage(params.error);
  const codexCommand = params.codexCommand ?? "codex";
  const currentMode = params.sessionMode ?? params.role;
  const executeBlocked = message.match(
    /blocked execute outside controlled workspace:\s*([\s\S]+)/i,
  );
  const fileBlocked = message.match(
    /blocked (read|write|edit|move|delete) outside controlled workspace:\s*([\s\S]+)/i,
  );
  const noSafePath = /no safe path scope detected/i.test(message);
  const usageLimited = /usage_limit_exceeded|usage limit/i.test(message);
  const authMissing = /OPENAI_API_KEY|CODEX_API_KEY|authenticate/i.test(message);

  if (params.accountRole === "admin" && currentMode !== "admin") {
    return [
      "Codex 调用失败了。",
      message,
      `当前账号默认角色：admin`,
      `当前会话模式：${currentMode}`,
      "如果你本来想用管理员权限，先发 `/mode admin` 切回管理员模式，再重试。",
      "如果想彻底清掉这次会话里的临时模式，也可以先发 `/reset`。",
    ].join("\n");
  }

  if (params.role === "admin") {
    return [
      "Codex 调用失败了。",
      message,
      `可以先在服务器上用同一个用户执行 \`${codexCommand} exec --skip-git-repo-check "你好"\` 验证登录和非交互执行是否正常。`,
    ].join("\n");
  }

  if (executeBlocked) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求触发了权限限制。如果你确实需要更高权限，请让 您的家庭管理员 来执行。",
    ].join("\n");
  }

  if (fileBlocked) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求触发了权限限制。如果你确实需要更高权限，请让 您的家庭管理员 来执行。",
    ].join("\n");
  }

  if (noSafePath) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求触发了权限限制。如果你确实需要更高权限，请让 您的家庭管理员 来执行。",
    ].join("\n");
  }

  if (usageLimited) {
    return [
      "这次没有执行成功。",
      "原因：当前模型额度不足或触发了限流。",
      message,
      "稍后重试，或检查对应模型/API 的额度与限流状态。",
    ].join("\n");
  }

  if (/Codex timed out|ACP prompt timed out|prompt did not acknowledge cancel/i.test(message)) {
    return [
      "这轮处理超过等待时间了。",
      "我已经尝试停止后台任务，但没有拿到可发送的最终内容。你可以把任务范围缩小一点再试，或者让管理员查看服务日志确认 ACP 是否卡住。",
    ].join("\n");
  }

  if (authMissing) {
    return [
      "这次没有执行成功。",
      "原因：Codex 鉴权还没准备好。",
      message,
      "请检查当前服务用户的 API key 或登录态配置。",
    ].join("\n");
  }

  if (/outside controlled workspace|blocked execute|blocked read|blocked write|blocked edit|blocked move|blocked delete/i.test(message)) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求触发了权限限制。如果你确实需要更高权限，请让 您的家庭管理员 来执行。",
    ].join("\n");
  }

  if (/permission|denied|not allowed|cancelled/i.test(message)) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求触发了权限限制。如果你确实需要更高权限，请让 您的家庭管理员 来执行。",
    ].join("\n");
  }

  return [
    "Codex 调用失败了。",
    message,
    "如果你愿意，可以换一种更小范围的做法再试一次。",
  ].join("\n");
}

export function buildCommandErrorReply(params: {
  error: unknown;
  role: UserRole;
}): string {
  const message = errorToRedactedMessage(params.error);

  return params.role === "admin"
    ? `命令执行失败：${message}`
    : "这个命令暂时没有执行成功。";
}

export function buildThinkingNoticeText(params: {
  role: UserRole;
  elapsedSeconds: number;
}): string {
  return params.role === "admin"
    ? `我已思考 ${params.elapsedSeconds} 秒，还在处理，稍等一下。`
    : `我已经想了 ${params.elapsedSeconds} 秒，还在处理，稍等我一下哦。`;
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let next = value / 1024;
  for (const unit of units) {
    if (next < 1024 || unit === units[units.length - 1]) {
      return `${next.toFixed(next >= 10 ? 1 : 2)} ${unit}`;
    }
    next /= 1024;
  }

  return `${value} B`;
}
