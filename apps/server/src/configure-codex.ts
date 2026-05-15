import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CodexCliAuthMode = "login" | "api_key";

interface DotEnv {
  [key: string]: string | undefined;
}

function usage(): string {
  return [
    "用法：node dist/apps/server/configure-codex.js [选项]",
    "",
    "选项：",
    "  --apply       写入 ~/.codex/config.toml 和需要时的 auth.json",
    "  --dry-run     只打印目标配置，不写文件（默认）",
    "  -h, --help    显示帮助",
    "",
    "常用 .env：",
    "  CODEX_CLI_AUTH_MODE=api_key",
    "  CODEX_CLI_BASE_URL=https://你的-sub2api/v1",
    "  CODEX_CLI_API_KEY=sk-...",
    "  CODEX_CLI_MODEL=gpt-5.5",
  ].join("\n");
}

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

function loadDotEnv(): DotEnv {
  const envPath = path.resolve(".env");
  const values: DotEnv = {};
  if (!fs.existsSync(envPath)) {
    return values;
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
    if (!key) {
      continue;
    }

    values[key] = unquoteEnvValue(trimmed.slice(separatorIndex + 1));
  }

  return values;
}

function readValue(env: DotEnv, name: string, fallback = ""): string {
  return process.env[name] ?? env[name] ?? fallback;
}

function readOptionalValue(env: DotEnv, name: string): string | undefined {
  const value = process.env[name] ?? env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBool(env: DotEnv, name: string, fallback: boolean): boolean {
  const raw = readValue(env, name);
  if (!raw) {
    return fallback;
  }

  return raw === "1" || raw.toLowerCase() === "true";
}

function readPositiveInteger(
  env: DotEnv,
  name: string,
  fallback: number,
): number {
  const raw = readValue(env, name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 不是有效正整数：${raw}`);
  }

  return parsed;
}

function readAuthMode(env: DotEnv): CodexCliAuthMode {
  const raw = readValue(env, "CODEX_CLI_AUTH_MODE", "login");
  if (raw !== "login" && raw !== "api_key") {
    throw new Error("CODEX_CLI_AUTH_MODE 只能是 login 或 api_key");
  }

  return raw;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isFilesystemRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === path.parse(resolved).root;
}

function buildTrustedProjectBlocks(env: DotEnv): string[] {
  const candidates = [
    path.resolve(__dirname, "..", "..", ".."),
    process.cwd(),
    readOptionalValue(env, "CODEX_ADMIN_WORKSPACE"),
  ];
  const projectPaths = [
    ...new Set(
      candidates
        .filter((item): item is string => Boolean(item?.trim()))
        .map((item) => path.resolve(item))
        .filter((item) => !isFilesystemRoot(item)),
    ),
  ];

  return projectPaths.flatMap((projectPath) => [
    `[projects.${tomlString(projectPath)}]`,
    `trust_level = ${tomlString("trusted")}`,
    "",
  ]);
}

function buildConfigToml(env: DotEnv): string {
  const baseUrl = readValue(env, "CODEX_CLI_BASE_URL");
  const provider = readValue(
    env,
    "CODEX_CLI_PROVIDER",
    baseUrl ? "openai_compat" : "openai",
  );
  const providerName = readValue(
    env,
    "CODEX_CLI_PROVIDER_NAME",
    baseUrl ? "OpenAI-compatible" : "OpenAI",
  );
  const wireApi = readValue(env, "CODEX_CLI_WIRE_API", "responses");
  const defaultModel = readValue(env, "CODEX_DEFAULT_MODEL", "gpt-5.5");
  const model = readValue(env, "CODEX_CLI_MODEL", defaultModel);
  const reviewModel = readValue(env, "CODEX_CLI_REVIEW_MODEL", model);
  const reasoningEffort = readValue(env, "CODEX_CLI_REASONING_EFFORT", "high");
  const disableResponseStorage = readBool(
    env,
    "CODEX_CLI_DISABLE_RESPONSE_STORAGE",
    true,
  );
  const networkAccess = readValue(env, "CODEX_CLI_NETWORK_ACCESS", "enabled");
  const contextWindow = readPositiveInteger(
    env,
    "CODEX_CLI_CONTEXT_WINDOW",
    272_000,
  );
  const compactLimit = readPositiveInteger(
    env,
    "CODEX_CLI_AUTO_COMPACT_TOKEN_LIMIT",
    240_000,
  );

  const providerBlock = baseUrl
    ? [
        `[model_providers.${provider}]`,
        `name = ${tomlString(providerName)}`,
        `base_url = ${tomlString(baseUrl)}`,
        `wire_api = ${tomlString(wireApi)}`,
        "requires_openai_auth = false",
        "",
      ]
    : [];
  const trustedProjectBlocks = buildTrustedProjectBlocks(env);

  return [
    `model_provider = ${tomlString(provider)}`,
    `model = ${tomlString(model)}`,
    `review_model = ${tomlString(reviewModel)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    `disable_response_storage = ${disableResponseStorage ? "true" : "false"}`,
    `network_access = ${tomlString(networkAccess)}`,
    "windows_wsl_setup_acknowledged = true",
    `model_context_window = ${contextWindow}`,
    `model_auto_compact_token_limit = ${compactLimit}`,
    "",
    ...providerBlock,
    ...trustedProjectBlocks,
  ].join("\n");
}

function maskKey(value: string): string {
  if (!value) {
    return "(empty)";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)} (${value.length} chars)`;
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, `${filePath}.bak.${stamp}`);
}

function writePrivateJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore POSIX permissions.
  }
}

function resolveCodexHome(env: DotEnv): string {
  const configuredHome =
    readOptionalValue(env, "CODEX_CLI_HOME") ??
    readOptionalValue(env, "CODEX_ADMIN_HOME") ??
    readOptionalValue(env, "CODEX_FAMILY_HOME") ??
    process.env.CODEX_HOME;

  return path.resolve(configuredHome ?? path.join(os.homedir(), ".codex"));
}

function run(): void {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    return;
  }

  const apply = args.includes("--apply");
  const env = loadDotEnv();
  const authMode = readAuthMode(env);
  const apiKey = readValue(env, "CODEX_CLI_API_KEY");
  const codexCommand = readValue(env, "CODEX_ADMIN_COMMAND", "codex");
  const codexHome = resolveCodexHome(env);
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const configToml = buildConfigToml(env);

  if (authMode === "api_key" && !apiKey) {
    throw new Error("CODEX_CLI_AUTH_MODE=api_key 时必须设置 CODEX_CLI_API_KEY");
  }

  console.log(`Codex home: ${codexHome}`);
  console.log(`Auth mode: ${authMode}`);
  console.log(`Config: ${configPath}`);
  console.log(`Auth: ${authPath}`);
  console.log(`API key: ${authMode === "api_key" ? maskKey(apiKey) : "(不写入，沿用 codex login)"}`);
  console.log("");
  console.log(configToml.trimEnd());

  if (!apply) {
    console.log("");
    console.log("当前是 dry-run；确认无误后加 --apply 写入。");
    return;
  }

  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  backupFile(configPath);
  fs.writeFileSync(configPath, configToml, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Windows may ignore POSIX permissions.
  }

  if (authMode === "api_key") {
    backupFile(authPath);
    writePrivateJson(authPath, {
      auth_mode: "apikey",
      OPENAI_API_KEY: apiKey,
    });
  }

  console.log("");
  console.log("Codex CLI 配置已写入。下一步可运行：");
  console.log(`${codexCommand} exec --skip-git-repo-check "请用一句话回复：Codex 已接通"`);
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
