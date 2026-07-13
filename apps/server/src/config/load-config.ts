import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AppConfig,
  CodexAcpAuthMode,
  CodexBackendKind,
  CodexEnvMode,
  CodexMode,
  CodexProviderProfile,
  CodexReasoningEffort,
} from "./types.js";
import {
  CODEX_REASONING_EFFORTS,
  getCodexModelReasoningEfforts,
  isCodexModelReasoningEffortSupported,
} from "./reasoning.js";
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

function readCommand(name: string, fallback: string): string {
  const command = readOptionalEnv(name, fallback);
  if (
    path.isAbsolute(command) ||
    (!command.includes("/") && !command.includes("\\"))
  ) {
    return command;
  }

  return path.resolve(command);
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

function readReasoningEffort(
  name: string,
): CodexReasoningEffort | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }

  if (!CODEX_REASONING_EFFORTS.includes(raw as CodexReasoningEffort)) {
    throw new Error(
      `Environment variable ${name} is not a valid Codex reasoning effort: ${raw}`,
    );
  }

  return raw as CodexReasoningEffort;
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

function normalizeProviderEnvSuffix(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function validateProviderName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error(
      `Provider name must use letters, numbers, dot, dash, or underscore: ${name}`,
    );
  }

  if (name.toLowerCase() === "default") {
    throw new Error("Provider name 'default' is reserved");
  }
}

function buildProviderEnvOverrides(params: {
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (params.apiBaseUrl) {
    env.CODEX_API_BASE_URL = params.apiBaseUrl;
    env.CODEX_CLI_BASE_URL = params.apiBaseUrl;
    // A new endpoint must never inherit credentials from the default provider.
    env.CODEX_API_KEY = "";
    env.CODEX_CLI_API_KEY = "";
    env.OPENAI_API_KEY = "";
    env.CODEX_ACP_PREFERRED_AUTH_ENV = "";
  }
  if (params.apiKey) {
    env.CODEX_API_KEY = params.apiKey;
    env.CODEX_CLI_API_KEY = params.apiKey;
    env.OPENAI_API_KEY = params.apiKey;
    env.CODEX_ACP_PREFERRED_AUTH_ENV = "OPENAI_API_KEY";
  }
  if (params.model) {
    env.CODEX_API_MODEL = params.model;
    env.CODEX_CLI_MODEL = params.model;
  }

  return env;
}

function readTomlStringValue(text: string, key: string): string | undefined {
  const match = text.match(
    new RegExp(
      `^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
      "m",
    ),
  );
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return match[1].slice(1, -1);
  }
}

function parseCcSwitchSettings(settingsConfig: string): {
  apiKey?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  modelProvider?: string;
  providerName?: string;
  baseUrl?: string;
  wireApi?: string;
} {
  let parsed: {
    auth?: Record<string, unknown>;
    config?: unknown;
  } = {};
  try {
    parsed = JSON.parse(settingsConfig) as {
      auth?: Record<string, unknown>;
      config?: unknown;
    };
  } catch {
    return {};
  }

  const config = typeof parsed.config === "string" ? parsed.config : "";
  const apiKey =
    typeof parsed.auth?.OPENAI_API_KEY === "string"
      ? parsed.auth.OPENAI_API_KEY
      : typeof parsed.auth?.CODEX_API_KEY === "string"
        ? parsed.auth.CODEX_API_KEY
        : undefined;
  const model = readTomlStringValue(config, "model");
  const rawReasoningEffort = readTomlStringValue(
    config,
    "model_reasoning_effort",
  )
    ?.trim()
    .toLowerCase();
  const reasoningEffort =
    rawReasoningEffort &&
    CODEX_REASONING_EFFORTS.includes(
      rawReasoningEffort as CodexReasoningEffort,
    )
      ? (rawReasoningEffort as CodexReasoningEffort)
      : undefined;
  const modelProvider = readTomlStringValue(config, "model_provider");
  const providerName = readTomlStringValue(config, "name");
  const baseUrl = readTomlStringValue(config, "base_url");
  const wireApi = readTomlStringValue(config, "wire_api");

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(providerName ? { providerName } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(wireApi ? { wireApi } : {}),
  };
}

function resolveCcSwitchDbPath(): string {
  const configured =
    process.env.CC_SWITCH_DB_PATH?.trim() ??
    process.env.CCSWITCH_DB_PATH?.trim();
  return path.resolve(
    configured || path.join(os.homedir(), ".cc-switch", "cc-switch.db"),
  );
}

function buildProviderAcpArgs(params: {
  modelProvider?: string | undefined;
  providerName?: string | undefined;
  baseUrl?: string | undefined;
  wireApi?: string | undefined;
  envKey?: string | undefined;
}): string[] {
  if (!params.modelProvider || !params.baseUrl) {
    return [];
  }

  const prefix = `model_providers.${params.modelProvider}`;
  return [
    "-c",
    `model_provider=${JSON.stringify(params.modelProvider)}`,
    ...(params.providerName
      ? ["-c", `${prefix}.name=${JSON.stringify(params.providerName)}`]
      : []),
    "-c",
    `${prefix}.base_url=${JSON.stringify(params.baseUrl)}`,
    ...(params.wireApi
      ? ["-c", `${prefix}.wire_api=${JSON.stringify(params.wireApi)}`]
      : []),
    ...(params.envKey
      ? ["-c", `${prefix}.env_key=${JSON.stringify(params.envKey)}`]
      : []),
    "-c",
    `${prefix}.requires_openai_auth=false`,
  ];
}

function readCcSwitchProviderProfiles(): CodexProviderProfile[] {
  const dbPath = resolveCcSwitchDbPath();
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `
        SELECT id, name, settings_config
        FROM providers
        WHERE app_type = 'codex'
        ORDER BY is_current DESC, sort_index IS NULL, sort_index ASC, name ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;
    const endpointStatement = db.prepare(
      `
      SELECT url
      FROM provider_endpoints
      WHERE provider_id = ? AND app_type = 'codex'
      ORDER BY id ASC
      LIMIT 1
      `,
    );

    return rows
      .map((row): CodexProviderProfile | undefined => {
        const parsed = parseCcSwitchSettings(String(row.settings_config ?? ""));
        const endpoint = endpointStatement.get(String(row.id)) as
          | { url?: string }
          | undefined;
        const apiBaseUrl = parsed.baseUrl ?? endpoint?.url;
        const model = parsed.model;
        const apiKey = parsed.apiKey;
        const rawName = String(row.id).trim();
        const name =
          rawName.toLowerCase() === "default" ? "ccswitch-default" : rawName;
        if (!apiBaseUrl || !apiKey) {
          return undefined;
        }
        try {
          validateProviderName(name);
        } catch {
          return undefined;
        }

        return {
          name,
          displayName: `cc-switch: ${String(row.name)}`,
          acpArgs: buildProviderAcpArgs({
            modelProvider:
              parsed.modelProvider ??
              `ccswitch_${normalizeProviderEnvSuffix(name).toLowerCase()}`,
            providerName: parsed.providerName ?? String(row.name),
            baseUrl: apiBaseUrl,
            wireApi: parsed.wireApi ?? "responses",
            envKey: "OPENAI_API_KEY",
          }),
          envOverrides: buildProviderEnvOverrides({
            apiBaseUrl,
            apiKey,
            ...(model ? { model } : {}),
          }),
          apiBaseUrl,
          apiKey,
          ...(model ? { model, apiModel: model } : {}),
          ...(parsed.reasoningEffort
            ? { reasoningEffort: parsed.reasoningEffort }
            : {}),
        };
      })
      .filter((profile): profile is CodexProviderProfile => Boolean(profile));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {

    }
  }
}

function readProviderProfiles(): CodexProviderProfile[] {
  const names = readNameList("CODEX_PROVIDER_NAMES");
  const profiles: CodexProviderProfile[] = [];
  const seen = new Set<string>();
  const envSuffixOwners = new Map<string, string>();

  for (const rawName of names) {
    const name = rawName.trim();
    validateProviderName(name);
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`Duplicate provider name: ${name}`);
    }
    seen.add(normalized);

    const envSuffix = normalizeProviderEnvSuffix(name);
    const suffixOwner = envSuffixOwners.get(envSuffix);
    if (suffixOwner) {
      throw new Error(
        `Provider names '${suffixOwner}' and '${name}' use the same environment variable suffix: ${envSuffix}`,
      );
    }
    envSuffixOwners.set(envSuffix, name);

    const prefix = `CODEX_PROVIDER_${envSuffix}`;
    const apiKeyEnv = readOptionalTrimmedEnv(`${prefix}_API_KEY_ENV`);
    const apiKey =
      readOptionalTrimmedEnv(`${prefix}_API_KEY`) ??
      (apiKeyEnv ? readOptionalTrimmedEnv(apiKeyEnv) : undefined);
    const apiBaseUrl = readOptionalTrimmedEnv(`${prefix}_API_BASE_URL`);
    const apiModel = readOptionalTrimmedEnv(`${prefix}_API_MODEL`);
    const model = readOptionalTrimmedEnv(`${prefix}_MODEL`);
    const backend = readOptionalTrimmedEnv(`${prefix}_BACKEND`);
    if (
      backend &&
      !VALID_CODEX_BACKENDS.includes(backend as CodexBackendKind)
    ) {
      throw new Error(
        `Environment variable ${prefix}_BACKEND is not a valid Codex backend: ${backend}`,
      );
    }
    const effectiveModel = apiModel ?? model;
    const displayName = readOptionalTrimmedEnv(`${prefix}_DISPLAY_NAME`);
    const reasoningEffort = readReasoningEffort(`${prefix}_REASONING_EFFORT`);
    const codexHome = readOptionalPath(`${prefix}_CODEX_HOME`);
    if (reasoningEffort) {
      for (const profileModel of new Set([model, apiModel].filter(Boolean))) {
        if (
          !isCodexModelReasoningEffortSupported(
            profileModel as string,
            reasoningEffort,
          )
        ) {
          const supported =
            getCodexModelReasoningEfforts(profileModel as string) ?? [];
          throw new Error(
            `${prefix}_REASONING_EFFORT=${reasoningEffort} is not supported by ${profileModel}; choose: ${supported.join(", ")}`,
          );
        }
      }
    }
    const generatedAcpArgs = apiBaseUrl
      ? buildProviderAcpArgs({
          modelProvider: `gateway_${normalizeProviderEnvSuffix(name).toLowerCase()}`,
          providerName: displayName ?? name,
          baseUrl: apiBaseUrl,
          wireApi: "responses",
          ...(apiKey ? { envKey: "OPENAI_API_KEY" } : {}),
        })
      : [];
    const profile: CodexProviderProfile = {
      name,
      acpArgs: [...generatedAcpArgs, ...readAcpArgs(`${prefix}_ACP_ARGS`)],
      envOverrides: buildProviderEnvOverrides({
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
      }),
      ...(displayName ? { displayName } : {}),
      ...(backend ? { backend: backend as CodexBackendKind } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(apiModel ? { apiModel } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(codexHome ? { codexHome } : {}),
    };
    profiles.push(profile);
  }

  const profileNames = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  for (const profile of readCcSwitchProviderProfiles()) {
    if (!profileNames.has(profile.name.toLowerCase())) {
      profiles.push(profile);
      profileNames.add(profile.name.toLowerCase());
    }
  }

  return profiles;
}

function resolveProjectBinary(name: "codex" | "codex-acp"): string {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    ".bin",
    executable,
  );
}

function resolveDefaultCodexCommand(): string {
  return resolveProjectBinary("codex");
}

function resolveDefaultAcpCommand(): string {
  return resolveProjectBinary("codex-acp");
}

function resolveDefaultCodexWorkspace(name: "admin" | "family"): string {
  return name === "admin"
    ? "./runtime/codex-admin"
    : "./runtime/codex-family";
}

function readDefaultChatModel(): string {
  return readOptionalEnv("CODEX_DEFAULT_MODEL", "gpt-5.6-sol");
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
  const sharedReasoningEffort =
    readReasoningEffort("CODEX_CLI_REASONING_EFFORT") ?? "high";
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
      adminAutoRotateEnabled: readBoolean(
        "SESSION_ADMIN_AUTO_ROTATE_ENABLED",
        false,
      ),
      familyAutoRotateEnabled: readBoolean(
        "SESSION_FAMILY_AUTO_ROTATE_ENABLED",
        true,
      ),
      familyHotIdleMinutes: readPositiveInteger(
        "SESSION_FAMILY_HOT_IDLE_MINUTES",
        90,
      ),
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
        command: readCommand(
          "CODEX_ADMIN_COMMAND",
          resolveDefaultCodexCommand(),
        ),
        args: readCodexArgs("CODEX_ADMIN_ARGS"),
        acpCommand: readCommand(
          "CODEX_ADMIN_ACP_COMMAND",
          resolveDefaultAcpCommand(),
        ),
        acpArgs: readAcpArgs("CODEX_ADMIN_ACP_ARGS"),
        acpAuthMode: readAcpAuthMode(
          "CODEX_ADMIN_ACP_AUTH_MODE",
          codexAcpAuthMode,
        ),
        acpWorkspaceIsolation: false,
        apiBaseUrl: readOptionalTrimmedEnv("CODEX_ADMIN_API_BASE_URL") ?? codexApiBaseUrl,
        apiKey: readOptionalTrimmedEnv("CODEX_ADMIN_API_KEY") ?? codexApiKey,
        apiModel: readOptionalEnv("CODEX_ADMIN_API_MODEL", codexApiModel),
        apiPromptCacheKeyPrefix: readOptionalEnv(
          "CODEX_ADMIN_API_PROMPT_CACHE_KEY_PREFIX",
          "wechat-admin",
        ),
        codexHome: readOptionalPath("CODEX_ADMIN_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
        envOverrides: {},
        roleOverrides: { reasoningEffort: sharedReasoningEffort },
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
        command: readCommand(
          "CODEX_FAMILY_COMMAND",
          resolveDefaultCodexCommand(),
        ),
        args: readCodexArgs("CODEX_FAMILY_ARGS"),
        acpCommand: readCommand(
          "CODEX_FAMILY_ACP_COMMAND",
          resolveDefaultAcpCommand(),
        ),
        acpArgs: readAcpArgs("CODEX_FAMILY_ACP_ARGS"),
        acpAuthMode: readAcpAuthMode(
          "CODEX_FAMILY_ACP_AUTH_MODE",
          codexAcpAuthMode,
        ),
        acpWorkspaceIsolation: true,
        apiBaseUrl: readOptionalTrimmedEnv("CODEX_FAMILY_API_BASE_URL") ?? codexApiBaseUrl,
        apiKey: readOptionalTrimmedEnv("CODEX_FAMILY_API_KEY") ?? codexApiKey,
        apiModel: readOptionalEnv("CODEX_FAMILY_API_MODEL", codexApiModel),
        apiPromptCacheKeyPrefix: readOptionalEnv(
          "CODEX_FAMILY_API_PROMPT_CACHE_KEY_PREFIX",
          "wechat-family",
        ),
        codexHome: readOptionalPath("CODEX_FAMILY_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
        envOverrides: {},
        roleOverrides: { reasoningEffort: sharedReasoningEffort },
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
      providers: readProviderProfiles(),
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
