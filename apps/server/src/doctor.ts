import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import {
  AcpConnection,
  buildAcpLaunch,
  hasAcpEnvAuth,
  resolveAcpRuntimeCodexHome,
} from "./codex/acp-connection.js";
import { AppDatabase } from "./storage/index.js";
import { CodexRuntimeConfig } from "./config/types.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function ok(name: string, detail: string): CheckResult {
  return { name, ok: true, detail };
}

function fail(name: string, detail: string): CheckResult {
  return { name, ok: false, detail };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function parseNodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".", 1)[0] ?? "0", 10);
}

function checkNode(): CheckResult {
  const major = parseNodeMajor(process.version);
  return major >= 22
    ? ok("Node.js", process.version)
    : fail("Node.js", `${process.version}，需要 >= 22`);
}

function checkEnvFilePermissions(envPath: string): CheckResult {
  if (!fs.existsSync(envPath)) {
    return fail(".env 权限", "文件不存在");
  }

  if (process.platform === "win32") {
    return ok(".env 权限", "windows skipped");
  }

  const mode = fs.statSync(envPath).mode & 0o777;
  if ((mode & 0o007) !== 0) {
    return fail(
      ".env 权限",
      `${mode.toString(8)}，建议不要让 other 读取：chmod o-rwx ${envPath}`,
    );
  }

  return ok(".env 权限", mode.toString(8));
}

function checkDiskSpace(directory: string): CheckResult {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.statfsSync(directory);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const freeMiB = Math.floor(freeBytes / 1024 / 1024);
    return freeBytes >= 512 * 1024 * 1024
      ? ok("磁盘空间", `${directory} free=${freeMiB}MiB`)
      : fail("磁盘空间", `${directory} free=${freeMiB}MiB，建议至少 512MiB`);
  } catch (error) {
    return fail("磁盘空间", error instanceof Error ? error.message : String(error));
  }
}

function checkCommand(command: string, args: string[]): Promise<CheckResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(
        fail(command, error instanceof Error ? error.message : String(error)),
      );
      return;
    }

    let output = "";
    let settled = false;
    const finish = (result: CheckResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(fail(command, "执行超时"));
    }, 10_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish(fail(command, error.message));
    });
    child.once("close", (code) => {
      const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? "";
      if (code === 0) {
        finish(ok(command, firstLine || "ok"));
      } else {
        finish(fail(command, firstLine || `exit ${code}`));
      }
    });
  });
}

async function checkAcpCommand(command: string): Promise<CheckResult> {
  const result = await checkCommand(command, ["--version"]);
  if (!result.ok) {
    return result;
  }

  return ok(command, result.detail || "ACP adapter is callable");
}

function checkAcpAuth(name: string, config: CodexRuntimeConfig): CheckResult {
  if (config.backend !== "acp") {
    return ok(name, "not enabled");
  }

  const hasEnvAuth = hasAcpEnvAuth(config);
  const detail = `CODEX_*_ACP_AUTH_MODE=${config.acpAuthMode}, env_key=${hasEnvAuth}`;

  if (config.acpAuthMode !== "env") {
    return ok(
      name,
      hasEnvAuth
        ? `${detail}; will use env auth`
        : `${detail}; will rely on codex-acp agent login state`,
    );
  }

  return hasEnvAuth
    ? ok(name, detail)
    : fail(
        name,
        `${detail}; set CODEX_CLI_API_KEY, OPENAI_API_KEY, or CODEX_API_KEY for codex-acp`,
      );
}

function checkFamilyAcpIsolation(config: CodexRuntimeConfig): CheckResult {
  if (config.backend !== "acp") {
    return ok("family ACP 文件隔离", "not enabled");
  }
  if (!config.acpWorkspaceIsolation) {
    return fail("family ACP 文件隔离", "workspace permission profile is disabled");
  }

  try {
    const launch = buildAcpLaunch(config);
    const leakedKeys = Object.keys(launch.env).filter((key) =>
      /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(key),
    );
    const codexConfig = JSON.parse(launch.env.CODEX_CONFIG ?? "{}") as Record<
      string,
      unknown
    >;
    const profileName = codexConfig.default_permissions;
    if (profileName !== "weixin_family") {
      return fail("family ACP 文件隔离", "default permission profile is missing");
    }
    const permissions = codexConfig.permissions;
    const profile =
      permissions && typeof permissions === "object" && !Array.isArray(permissions)
        ? (permissions as Record<string, unknown>)[profileName]
        : undefined;
    const filesystem =
      profile && typeof profile === "object" && !Array.isArray(profile)
        ? (profile as Record<string, unknown>).filesystem
        : undefined;
    const filesystemRules =
      filesystem && typeof filesystem === "object" && !Array.isArray(filesystem)
        ? (filesystem as Record<string, unknown>)
        : undefined;
    if (
      !filesystemRules ||
      filesystemRules[":root"] !== "deny" ||
      filesystemRules[":slash_tmp"] !== "deny" ||
      filesystemRules[path.resolve(os.tmpdir())] !== "deny" ||
      filesystemRules[path.dirname(config.workspace)] !== "deny"
    ) {
      return fail(
        "family ACP 文件隔离",
        "root, workspace parent, or temporary directory deny rules are missing",
      );
    }
    const shellPolicy = codexConfig.shell_environment_policy;
    const shellSet =
      shellPolicy && typeof shellPolicy === "object" && !Array.isArray(shellPolicy)
        ? (shellPolicy as Record<string, unknown>).set
        : undefined;
    const shellEnvironment =
      shellSet && typeof shellSet === "object" && !Array.isArray(shellSet)
        ? (shellSet as Record<string, unknown>)
        : undefined;
    if (
      shellEnvironment?.TMPDIR !== path.join(config.workspace, ".tmp") ||
      shellEnvironment?.TMP !== shellEnvironment.TMPDIR ||
      shellEnvironment?.TEMP !== shellEnvironment.TMPDIR
    ) {
      return fail(
        "family ACP 文件隔离",
        "sandboxed temporary directory is not inside the family workspace",
      );
    }
    const familyCodexHome = resolveAcpRuntimeCodexHome(config);
    if (
      launch.env.CODEX_HOME !== familyCodexHome ||
      fs.existsSync(path.join(familyCodexHome, "auth.json"))
    ) {
      return fail(
        "family ACP 文件隔离",
        "family ACP host home is shared or contains persistent credentials",
      );
    }
    if (leakedKeys.length > 0) {
      return fail(
        "family ACP 文件隔离",
        `credential-like child environment keys: ${leakedKeys.join(", ")}`,
      );
    }
    if (config.apiBaseUrl && launch.apiKey && !launch.gatewayAuth) {
      return fail("family ACP 文件隔离", "isolated gateway authentication is missing");
    }
    return ok(
      "family ACP 文件隔离",
      `profile=${profileName}, root_deny=true, workspace_tmp=true, isolated_home=true, child_credentials=0, gateway_auth=${Boolean(launch.gatewayAuth)}`,
    );
  } catch (error) {
    return fail(
      "family ACP 文件隔离",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function checkAcpRuntimeHomeIsolation(
  name: string,
  config: CodexRuntimeConfig,
): CheckResult {
  if (config.backend !== "acp" || !config.apiBaseUrl) {
    return ok(name, "gateway authentication not enabled");
  }
  try {
    const launch = buildAcpLaunch(config);
    if (!launch.gatewayAuth) {
      return fail(name, "protected gateway authentication is missing");
    }
    const runtimeHome = resolveAcpRuntimeCodexHome(config);
    const codexConfig = JSON.parse(launch.env.CODEX_CONFIG ?? "{}") as Record<
      string,
      unknown
    >;
    if (
      launch.env.CODEX_HOME !== runtimeHome ||
      launch.env.CODEX_CLI_HOME !== undefined ||
      runtimeHome === config.codexHome ||
      fs.existsSync(path.join(runtimeHome, "auth.json")) ||
      codexConfig.cli_auth_credentials_store !== "file"
    ) {
      return fail(
        name,
        "ACP runtime home is shared, contains credentials, or can use the OS credential store",
      );
    }
    return ok(name, `${runtimeHome}, auth.json=absent`);
  } catch (error) {
    return fail(name, error instanceof Error ? error.message : String(error));
  }
}

async function checkAcpSession(
  name: string,
  config: CodexRuntimeConfig,
): Promise<CheckResult> {
  if (config.backend !== "acp") {
    return ok(name, "not enabled");
  }

  fs.mkdirSync(config.workspace, { recursive: true });
  const connection = new AcpConnection(config, () => undefined);
  try {
    const conn = await withTimeout(
      connection.ensureReady(),
      Math.min(config.timeoutMs, 60_000),
      "ACP initialize timed out",
    );
    const response = await withTimeout(
      conn.newSession({
        cwd: config.workspace,
        mcpServers: [],
      }),
      Math.min(config.timeoutMs, 60_000),
      "ACP newSession timed out",
    );
    return ok(
      name,
      `session=${response.sessionId}, loadSession=${connection.supportsLoadSession()}, additionalDirectories=${connection.supportsAdditionalDirectories()}`,
    );
  } catch (error) {
    return fail(name, error instanceof Error ? error.message : String(error));
  } finally {
    connection.dispose();
  }
}

function checkHttpHealth(port: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: 5_000,
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve(ok("HTTP /healthz", `127.0.0.1:${port}`));
        } else {
          resolve(fail("HTTP /healthz", `HTTP ${response.statusCode}`));
        }
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(fail("HTTP /healthz", "请求超时，服务可能未启动"));
    });
    request.on("error", (error) => {
      resolve(fail("HTTP /healthz", error.message));
    });
  });
}

function checkWritableDirectories(
  name: string,
  directories: string[],
): CheckResult {
  const failures: string[] = [];
  for (const directory of directories) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      failures.push(
        `${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return failures.length === 0
    ? ok(name, directories.join(", "))
    : fail(name, failures.join("; "));
}

async function run(): Promise<void> {
  const outputJson = process.argv.includes("--json");
  const runCodex = process.argv.includes("--codex");
  const runAcpSession = process.argv.includes("--acp-session");
  const results: CheckResult[] = [checkNode()];
  const config = loadConfig();

  results.push(
    fs.existsSync(path.resolve(".env"))
      ? ok(".env", path.resolve(".env"))
      : fail(".env", "当前目录没有 .env，systemd 运行时通常需要它"),
  );
  results.push(checkEnvFilePermissions(path.resolve(".env")));

  try {
    fs.mkdirSync(config.server.dataDir, { recursive: true });
    results.push(ok("数据目录", config.server.dataDir));
  } catch (error) {
    results.push(
      fail(
        "数据目录",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  results.push(checkDiskSpace(config.server.dataDir));

  results.push(
    checkWritableDirectories("文件发送白名单目录", config.fileSend.allowedDirs),
  );
  results.push(
    config.codex.family.envMode === "minimal"
      ? ok("family 环境隔离", "CODEX_FAMILY_ENV_MODE=minimal")
      : fail(
          "family 环境隔离",
          `CODEX_FAMILY_ENV_MODE=${config.codex.family.envMode}`,
        ),
  );
  results.push(
    ok(
      "Codex backend",
      `admin=${config.codex.admin.backend}, family=${config.codex.family.backend}`,
    ),
  );
  results.push(
    ok(
      "Codex models",
      [
        `admin_chat=${config.codex.admin.apiModel}`,
        `family_chat=${config.codex.family.apiModel}`,
        `admin_review=${config.codex.admin.permissionReview?.model ?? "(disabled)"}`,
        `family_review=${config.codex.family.permissionReview?.model ?? "(disabled)"}`,
      ].join(", "),
    ),
  );

  try {
    const database = new AppDatabase(
      path.join(config.server.dataDir, "weixin-household-gateway.sqlite"),
    );
    database.initialize();
    const accounts = database.listAccounts();
    const activeAccounts = accounts.filter((account) => account.status === "active");
    database.close();
    results.push(
      activeAccounts.length > 0
        ? ok("微信账号", `active=${activeAccounts.length}, total=${accounts.length}`)
        : fail("微信账号", `没有 active 账号，total=${accounts.length}`),
    );
  } catch (error) {
    results.push(
      fail(
        "SQLite",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  results.push(await checkCommand(config.codex.admin.command, ["--version"]));
  if (config.codex.admin.codexHome) {
    results.push(ok("Codex home admin", config.codex.admin.codexHome));
  }
  if (config.codex.family.command !== config.codex.admin.command) {
    results.push(await checkCommand(config.codex.family.command, ["--version"]));
  }
  if (
    config.codex.family.codexHome &&
    config.codex.family.codexHome !== config.codex.admin.codexHome
  ) {
    results.push(ok("Codex home family", config.codex.family.codexHome));
  }
  if (config.codex.admin.backend === "acp") {
    results.push(await checkAcpCommand(config.codex.admin.acpCommand));
    results.push(checkAcpAuth("Codex ACP auth admin", config.codex.admin));
    results.push(
      checkAcpRuntimeHomeIsolation(
        "Codex ACP runtime home admin",
        config.codex.admin,
      ),
    );
    if (runAcpSession) {
      results.push(
        await checkAcpSession("Codex ACP session admin", config.codex.admin),
      );
    }
  }
  if (
    config.codex.family.backend === "acp" &&
    config.codex.family.acpCommand !== config.codex.admin.acpCommand
  ) {
    results.push(await checkAcpCommand(config.codex.family.acpCommand));
  }
  if (config.codex.family.backend === "acp") {
    results.push(checkAcpAuth("Codex ACP auth family", config.codex.family));
    results.push(
      checkAcpRuntimeHomeIsolation(
        "Codex ACP runtime home family",
        config.codex.family,
      ),
    );
    results.push(checkFamilyAcpIsolation(config.codex.family));
    if (runAcpSession) {
      results.push(
        await checkAcpSession("Codex ACP session family", config.codex.family),
      );
    }
  }

  if (runCodex) {
    results.push(
      await checkCommand(config.codex.admin.command, [
        ...config.codex.admin.args,
        "请只回复：doctor-ok",
      ]),
    );
  }

  results.push(await checkHttpHealth(config.server.port));

  const failed = results.filter((result) => !result.ok).length;
  if (outputJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.ok ? "OK" : "FAIL"}  ${result.name}  ${result.detail}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
