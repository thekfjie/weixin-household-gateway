const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer ***"],
  [/\b(OPENAI_API_KEY|CODEX_API_KEY|CODEX_CLI_API_KEY|CODEX_API_BASE_URL|CODEX_CLI_BASE_URL)=([^\s]+)/g, "$1=***"],
  [/\b(auth_token|token|access_token|refresh_token)["']?\s*[:=]\s*["']?[^"',\s]+/gi, "$1=***"],
];

export function redactSensitiveText(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function errorToRedactedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}
