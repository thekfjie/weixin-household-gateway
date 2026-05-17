import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppConfig,
  CodexAcpAuthMode,
  CodexBackendKind,
  CodexEnvMode,
  CodexMode,
} from "./types.js";
import { splitCommandArgs } from "../utils/index.js";

const VALID_CODEX_MODES: readonly CodexMode[] = [
  "suggest",
  "auto-edit",
  "full-auto",
];
const VALID_CODEX_ENV_MODES: readonly CodexEnvMode[] = ["inherit", "minimal"];
const VALID_CODEX_BACKENDS: readonly CodexBackendKind[] = ["cli", "acp", "api"];
const VALID_CODEX_ACP_AUTH_MODES: readonly CodexAcpAuthMode[] = [
  "auto",
  "env",
  "none",
];

let dotEnvLoaded = false;

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadDotEnvFile(): void {
  if (dotEnvLoaded) {
    return;
  }
  dotEnvLoaded = true;

  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1));
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return raw === "1" || raw.toLowerCase() === "true";
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} is not a valid port: ${raw}`);
  }

  return parsed;
}

function readMode(name: string, fallback: CodexMode): CodexMode {
  const raw = (process.env[name] ?? fallback) as CodexMode;
  if (!VALID_CODEX_MODES.includes(raw)) {
    throw new Error(`Environment variable ${name} is not a valid Codex mode: ${raw}`);
  }

  return raw;
}

function readEnvMode(name: string, fallback: CodexEnvMode): CodexEnvMode {
  const raw = (process.env[name] ?? fallback) as CodexEnvMode;
  if (!VALID_CODEX_ENV_MODES.includes(raw)) {
    throw new Error(`Environment variable ${name} is not a valid Codex env mode: ${raw}`);
  }

  return raw;
}

function readBackend(name: string, fallback: CodexBackendKind): CodexBackendKind {
  const raw = (process.env[name] ?? fallback) as CodexBackendKind;
  if (!VALID_CODEX_BACKENDS.includes(raw)) {
    throw new Error(`Environment variable ${name} is not a valid Codex backend: ${raw}`);
  }

  return raw;
}

function readAcpAuthMode(
  name: string,
  fallback: CodexAcpAuthMode,
): CodexAcpAuthMode {
  const raw = (process.env[name] ?? fallback) as CodexAcpAuthMode;
  if (!VALID_CODEX_ACP_AUTH_MODES.includes(raw)) {
    throw new Error(
      `Environment variable ${name} is not a valid Codex ACP auth mode: ${raw}`,
    );
  }

  return raw;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} is not a positive integer: ${raw}`);
  }

  return parsed;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} is not a non-negative integer: ${raw}`);
  }

  return parsed;
}

function readArgs(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  return raw ? splitCommandArgs(raw, { strictQuotes: true }) : fallback;
}

function readCodexArgs(name: string): string[] {
  return readArgs(name, ["exec", "--skip-git-repo-check"]);
}

function readAcpArgs(name: string): string[] {
  return readArgs(name, []);
}

function readPathList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  const values = raw
    ? raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    : fallback;

  return [...new Set(values.map((item) => path.resolve(item)))];
}

function readNameList(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionalPath(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? path.resolve(raw) : undefined;
}

function readOptionalTrimmedEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw || undefined;
}

function resolveDefaultCodexCommand(): string {
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function resolveDefaultAcpCommand(): string {
  const localBin = path.resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex-acp.CMD" : "codex-acp",
  );
  return fs.existsSync(localBin)
    ? localBin
    : process.platform === "win32"
      ? "codex-acp.cmd"
      : "codex-acp";
}

function resolveDefaultCodexWorkspace(name: "admin" | "family"): string {
  return name === "admin"
    ? "./runtime/codex-admin"
    : "./runtime/codex-family";
}

function readDefaultChatModel(): string {
  return readOptionalEnv("CODEX_DEFAULT_MODEL", "gpt-5.5");
}

function resolveBundledPromptPath(relativePath: string): string {
  const cwdPath = path.resolve(relativePath);
  if (fs.existsSync(cwdPath)) {
    return cwdPath;
  }

  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    relativePath,
  );
}

function readPromptTemplate(
  envName: string,
  defaultRelativePath: string,
): string {
  const configuredPath = readOptionalPath(envName);
  const templatePath =
    configuredPath ?? resolveBundledPromptPath(defaultRelativePath);
  const text = fs.readFileSync(templatePath, "utf8").trim();
  if (!text) {
    throw new Error(`Prompt template is empty: ${templatePath}`);
  }

  return text;
}

export function loadConfig(): AppConfig {
  loadDotEnvFile();

  const dataDir = path.resolve(readEnv("DATA_DIR", "./data"));
  const routeTag = process.env.WECHAT_ROUTE_TAG?.trim() || undefined;
  const adminMode = readMode("CODEX_ADMIN_MODE", "full-auto");
  const familyMode = readMode("CODEX_FAMILY_MODE", "suggest");
  const codexBackend = readBackend("CODEX_BACKEND", "acp");
  const codexAcpAuthMode = readAcpAuthMode("CODEX_ACP_AUTH_MODE", "auto");
  const codexTimeoutMs = readPositiveInteger("CODEX_TIMEOUT_MS", 180_000);
  const defaultChatModel = readDefaultChatModel();
  const sharedCliBaseUrl = readOptionalTrimmedEnv("CODEX_CLI_BASE_URL");
  const sharedCliApiKey = readOptionalTrimmedEnv("CODEX_CLI_API_KEY");
  const sharedCliModel = readOptionalTrimmedEnv("CODEX_CLI_MODEL");
  const codexApiBaseUrl =
    readOptionalTrimmedEnv("CODEX_API_BASE_URL") ?? sharedCliBaseUrl;
  const codexApiKey =
    readOptionalTrimmedEnv("CODEX_API_KEY") ?? sharedCliApiKey;
  const codexApiModel =
    readOptionalTrimmedEnv("CODEX_API_MODEL") ?? sharedCliModel ?? defaultChatModel;
  const fileAllowedDirs = readPathList("FILE_SEND_ALLOWED_DIRS", [
    path.join(dataDir, "outbox"),
    path.join(dataDir, "inbox"),
    path.join(dataDir, "office"),
    os.tmpdir(),
  ]);

  return {
    server: {
      port: readPort("PORT", 18080),
      timezone: readEnv("TIMEZONE", "Asia/Shanghai"),
      dataDir,
    },
    wechat: {
      apiBaseUrl: readEnv("WECHAT_API_BASE_URL", "https://ilinkai.weixin.qq.com"),
      cdnBaseUrl: readEnv(
        "WECHAT_CDN_BASE_URL",
        "https://novac2c.cdn.weixin.qq.com/c2c",
      ),
      channelVersion: readEnv(
        "WECHAT_CHANNEL_VERSION",
        "weixin-household-gateway-0.1.0",
      ),
      ...(routeTag ? { routeTag } : {}),
      typingRefreshMs: readNonNegativeInteger("WECHAT_TYPING_REFRESH_MS", 6_000),
      thinkingNoticeMs: readNonNegativeInteger(
        "WECHAT_THINKING_NOTICE_MS",
        30_000,
      ),
      turnMessageLimit: readPositiveInteger("WECHAT_TURN_MESSAGE_LIMIT", 10),
      adminProgressEnabled: readBoolean("WECHAT_ADMIN_PROGRESS_ENABLED", true),
      familyProgressEnabled: readBoolean("WECHAT_FAMILY_PROGRESS_ENABLED", false),
      familyApiStreamingEnabled: readBoolean(
        "WECHAT_FAMILY_API_STREAMING_ENABLED",
        false,
      ),
    },
    session: {
      rotateIdleHours: readPositiveInteger("SESSION_ROTATE_IDLE_HOURS", 24),
      rotateMaxTurns: readPositiveInteger("SESSION_ROTATE_MAX_TURNS", 50),
      rotateMaxEstimatedTokens: readPositiveInteger(
        "SESSION_ROTATE_MAX_ESTIMATED_TOKENS",
        256_000,
      ),
    },
    codex: {
      admin: {
        backend: readBackend("CODEX_ADMIN_BACKEND", codexBackend),
        command: readEnv("CODEX_ADMIN_COMMAND", resolveDefaultCodexCommand()),
        args: readCodexArgs("CODEX_ADMIN_ARGS"),
        acpCommand: readOptionalEnv(
          "CODEX_ADMIN_ACP_COMMAND",
          resolveDefaultAcpCommand(),
        ),
        acpArgs: readAcpArgs("CODEX_ADMIN_ACP_ARGS"),
        acpAuthMode: readAcpAuthMode(
          "CODEX_ADMIN_ACP_AUTH_MODE",
          codexAcpAuthMode,
        ),
        apiBaseUrl: readOptionalTrimmedEnv("CODEX_ADMIN_API_BASE_URL") ?? codexApiBaseUrl,
        apiKey: readOptionalTrimmedEnv("CODEX_ADMIN_API_KEY") ?? codexApiKey,
        apiModel: readOptionalEnv("CODEX_ADMIN_API_MODEL", codexApiModel),
        apiPromptCacheKeyPrefix: readOptionalEnv(
          "CODEX_ADMIN_API_PROMPT_CACHE_KEY_PREFIX",
          "wechat-admin",
        ),
        codexHome: readOptionalPath("CODEX_ADMIN_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
        mode: adminMode,
        timeoutMs: readPositiveInteger(
          "CODEX_ADMIN_TIMEOUT_MS",
          codexTimeoutMs,
        ),
        workspace: path.resolve(
          readEnv(
            "CODEX_ADMIN_WORKSPACE",
            resolveDefaultCodexWorkspace("admin"),
          ),
        ),
        envMode: readEnvMode("CODEX_ADMIN_ENV_MODE", "inherit"),
        envPassthrough: readNameList("CODEX_ADMIN_ENV_PASSTHROUGH"),
        permissionReview: {
          enabled: false,
          model: readOptionalEnv("CODEX_ADMIN_PERMISSION_REVIEW_MODEL", "gpt-5.4-mini"),
          timeoutMs: readPositiveInteger("CODEX_ADMIN_PERMISSION_REVIEW_TIMEOUT_MS", 10_000),
        },
      },
      family: {
        backend: readBackend("CODEX_FAMILY_BACKEND", codexBackend),
        command: readEnv("CODEX_FAMILY_COMMAND", resolveDefaultCodexCommand()),
        args: readCodexArgs("CODEX_FAMILY_ARGS"),
        acpCommand: readOptionalEnv(
          "CODEX_FAMILY_ACP_COMMAND",
          resolveDefaultAcpCommand(),
        ),
        acpArgs: readAcpArgs("CODEX_FAMILY_ACP_ARGS"),
        acpAuthMode: readAcpAuthMode(
          "CODEX_FAMILY_ACP_AUTH_MODE",
          codexAcpAuthMode,
        ),
        apiBaseUrl: readOptionalTrimmedEnv("CODEX_FAMILY_API_BASE_URL") ?? codexApiBaseUrl,
        apiKey: readOptionalTrimmedEnv("CODEX_FAMILY_API_KEY") ?? codexApiKey,
        apiModel: readOptionalEnv("CODEX_FAMILY_API_MODEL", codexApiModel),
        apiPromptCacheKeyPrefix: readOptionalEnv(
          "CODEX_FAMILY_API_PROMPT_CACHE_KEY_PREFIX",
          "wechat-family",
        ),
        codexHome: readOptionalPath("CODEX_FAMILY_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
        mode: familyMode,
        timeoutMs: readPositiveInteger(
          "CODEX_FAMILY_TIMEOUT_MS",
          codexTimeoutMs,
        ),
        workspace: path.resolve(
          readEnv(
            "CODEX_FAMILY_WORKSPACE",
            resolveDefaultCodexWorkspace("family"),
          ),
        ),
        envMode: readEnvMode("CODEX_FAMILY_ENV_MODE", "minimal"),
        envPassthrough: readNameList("CODEX_FAMILY_ENV_PASSTHROUGH"),
        permissionReview: {
          enabled: readBoolean("CODEX_FAMILY_PERMISSION_REVIEW_ENABLED", true),
          model: readOptionalEnv("CODEX_FAMILY_PERMISSION_REVIEW_MODEL", "gpt-5.4-mini"),
          timeoutMs: readPositiveInteger("CODEX_FAMILY_PERMISSION_REVIEW_TIMEOUT_MS", 8_000),
        },
      },
    },
    prompts: {
      adminAcp: readPromptTemplate("PROMPT_ADMIN_ACP_FILE", "prompts/admin-acp.md"),
      adminApi: readPromptTemplate("PROMPT_ADMIN_API_FILE", "prompts/admin-api.md"),
      familyAcp: readPromptTemplate("PROMPT_FAMILY_ACP_FILE", "prompts/family-acp.md"),
      familyApi: readPromptTemplate("PROMPT_FAMILY_API_FILE", "prompts/family-api.md"),
    },
    familyPolicy: {
      stripReasoning: readBoolean("FAMILY_STRIP_REASONING", true),
      stripCommands: readBoolean("FAMILY_STRIP_COMMANDS", true),
      stripPaths: readBoolean("FAMILY_STRIP_PATHS", true),
      allowFileSend: readBoolean("ALLOW_FILE_SEND", true),
    },
    fileSend: {
      allowedDirs: fileAllowedDirs,
      maxBytes: readPositiveInteger("FILE_SEND_MAX_BYTES", 50 * 1024 * 1024),
    },
  };
}
