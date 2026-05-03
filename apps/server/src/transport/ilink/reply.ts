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

  return "我这边调用助手时出了一点问题，先稍等一下再试。";
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
