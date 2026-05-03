import { UserRole } from "../../config/types.js";
import { errorToRedactedMessage } from "../../policy/index.js";

export function splitReplyText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (maxChars <= 0 || trimmed.length <= maxChars) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

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
    const blockedCommand = executeBlocked[1]?.trim() || message;
    return [
      "这次没有执行成功。",
      "原因：工作区外系统命令被拦截了。",
      `被拦截命令：${blockedCommand}`,
      "如果这是处理当前会话文档所必需的命令，请让 admin 执行，或者把产物限制在当前会话的 inbox/office/outbox 内。",
    ].join("\n");
  }

  if (fileBlocked) {
    const blockedKind = fileBlocked[1] ?? "read";
    const blockedTarget = fileBlocked[2]?.trim() || message;
    return [
      "这次没有执行成功。",
      `原因：访问工作区外文件被拦截了（${blockedKind}）。`,
      blockedTarget,
      "请尽量只处理当前会话的 inbox、office、outbox 目录中的文件。",
    ].join("\n");
  }

  if (noSafePath) {
    return [
      "这次没有执行成功。",
      "原因：这次操作没有明确的安全路径范围，所以被权限策略拦截了。",
      message,
      "如果你是在处理附件或办公文件，请把输入文件和输出文件明确放在当前会话工作区里再试。",
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
      "原因：当前请求触发了权限限制。",
      message,
      "如果你只是要处理当前会话里的附件或工作区文件，可以换一种更收敛的做法再试；如果你确实需要更高权限，请让 admin 账号来执行。",
    ].join("\n");
  }

  if (/permission|denied|not allowed|cancelled/i.test(message)) {
    return [
      "Codex 调用失败了。",
      "原因：当前请求被权限策略拒绝了。",
      message,
      "如果这是合理操作，可以让 admin 账号来执行，或者把任务限制在当前会话工作区内再试。",
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
