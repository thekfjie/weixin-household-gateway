"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const index_js_1 = require("./config/index.js");
const acp_connection_js_1 = require("./codex/acp-connection.js");
const index_js_2 = require("./storage/index.js");
function ok(name, detail) {
    return { name, ok: true, detail };
}
function fail(name, detail) {
    return { name, ok: false, detail };
}
function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}
function parseNodeMajor(version) {
    return Number.parseInt(version.replace(/^v/, "").split(".", 1)[0] ?? "0", 10);
}
function checkNode() {
    const major = parseNodeMajor(process.version);
    return major >= 22
        ? ok("Node.js", process.version)
        : fail("Node.js", `${process.version}，需要 >= 22`);
}
function checkEnvFilePermissions(envPath) {
    if (!node_fs_1.default.existsSync(envPath)) {
        return fail(".env 权限", "文件不存在");
    }
    if (process.platform === "win32") {
        return ok(".env 权限", "windows skipped");
    }
    const mode = node_fs_1.default.statSync(envPath).mode & 0o777;
    if ((mode & 0o007) !== 0) {
        return fail(".env 权限", `${mode.toString(8)}，建议不要让 other 读取：chmod o-rwx ${envPath}`);
    }
    return ok(".env 权限", mode.toString(8));
}
function checkDiskSpace(directory) {
    try {
        node_fs_1.default.mkdirSync(directory, { recursive: true });
        const stat = node_fs_1.default.statfsSync(directory);
        const freeBytes = Number(stat.bavail) * Number(stat.bsize);
        const freeMiB = Math.floor(freeBytes / 1024 / 1024);
        return freeBytes >= 512 * 1024 * 1024
            ? ok("磁盘空间", `${directory} free=${freeMiB}MiB`)
            : fail("磁盘空间", `${directory} free=${freeMiB}MiB，建议至少 512MiB`);
    }
    catch (error) {
        return fail("磁盘空间", error instanceof Error ? error.message : String(error));
    }
}
function checkCommand(command, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = (0, node_child_process_1.spawn)(command, args, {
                shell: process.platform === "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            resolve(fail(command, error instanceof Error ? error.message : String(error)));
            return;
        }
        let output = "";
        let settled = false;
        const finish = (result) => {
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
        child.stdout?.on("data", (chunk) => {
            output += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            output += chunk.toString("utf8");
        });
        child.once("error", (error) => {
            finish(fail(command, error.message));
        });
        child.once("close", (code) => {
            const firstLine = output.trim().split(/\r?\n/, 1)[0] ?? "";
            if (code === 0) {
                finish(ok(command, firstLine || "ok"));
            }
            else {
                finish(fail(command, firstLine || `exit ${code}`));
            }
        });
    });
}
async function checkAcpCommand(command) {
    const result = await checkCommand(command, ["--help"]);
    if (!result.ok) {
        return result;
    }
    return ok(command, result.detail || "ACP adapter is callable");
}
function checkAcpAuth(name, config) {
    if (config.backend !== "acp") {
        return ok(name, "not enabled");
    }
    const hasEnvAuth = (0, acp_connection_js_1.hasAcpEnvAuth)(config);
    const detail = `CODEX_*_ACP_AUTH_MODE=${config.acpAuthMode}, env_key=${hasEnvAuth}`;
    if (config.acpAuthMode !== "env") {
        return ok(name, hasEnvAuth
            ? `${detail}; will use env auth`
            : `${detail}; will rely on codex-acp agent login state`);
    }
    return hasEnvAuth
        ? ok(name, detail)
        : fail(name, `${detail}; set CODEX_CLI_API_KEY, OPENAI_API_KEY, or CODEX_API_KEY for codex-acp`);
}
async function checkAcpSession(name, config) {
    if (config.backend !== "acp") {
        return ok(name, "not enabled");
    }
    node_fs_1.default.mkdirSync(config.workspace, { recursive: true });
    const connection = new acp_connection_js_1.AcpConnection(config, () => undefined);
    try {
        const conn = await withTimeout(connection.ensureReady(), Math.min(config.timeoutMs, 60_000), "ACP initialize timed out");
        const response = await withTimeout(conn.newSession({
            cwd: config.workspace,
            mcpServers: [],
        }), Math.min(config.timeoutMs, 60_000), "ACP newSession timed out");
        return ok(name, `session=${response.sessionId}, loadSession=${connection.supportsLoadSession()}, additionalDirectories=${connection.supportsAdditionalDirectories()}`);
    }
    catch (error) {
        return fail(name, error instanceof Error ? error.message : String(error));
    }
    finally {
        connection.dispose();
    }
}
function checkHttpHealth(port) {
    return new Promise((resolve) => {
        const request = node_http_1.default.get({
            host: "127.0.0.1",
            port,
            path: "/healthz",
            timeout: 5_000,
        }, (response) => {
            response.resume();
            if (response.statusCode === 200) {
                resolve(ok("HTTP /healthz", `127.0.0.1:${port}`));
            }
            else {
                resolve(fail("HTTP /healthz", `HTTP ${response.statusCode}`));
            }
        });
        request.on("timeout", () => {
            request.destroy();
            resolve(fail("HTTP /healthz", "请求超时，服务可能未启动"));
        });
        request.on("error", (error) => {
            resolve(fail("HTTP /healthz", error.message));
        });
    });
}
function checkWritableDirectories(name, directories) {
    const failures = [];
    for (const directory of directories) {
        try {
            node_fs_1.default.mkdirSync(directory, { recursive: true });
            node_fs_1.default.accessSync(directory, node_fs_1.default.constants.R_OK | node_fs_1.default.constants.W_OK);
        }
        catch (error) {
            failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return failures.length === 0
        ? ok(name, directories.join(", "))
        : fail(name, failures.join("; "));
}
async function run() {
    const outputJson = process.argv.includes("--json");
    const runCodex = process.argv.includes("--codex");
    const runAcpSession = process.argv.includes("--acp-session");
    const results = [checkNode()];
    const config = (0, index_js_1.loadConfig)();
    results.push(node_fs_1.default.existsSync(node_path_1.default.resolve(".env"))
        ? ok(".env", node_path_1.default.resolve(".env"))
        : fail(".env", "当前目录没有 .env，systemd 运行时通常需要它"));
    results.push(checkEnvFilePermissions(node_path_1.default.resolve(".env")));
    try {
        node_fs_1.default.mkdirSync(config.server.dataDir, { recursive: true });
        results.push(ok("数据目录", config.server.dataDir));
    }
    catch (error) {
        results.push(fail("数据目录", error instanceof Error ? error.message : String(error)));
    }
    results.push(checkDiskSpace(config.server.dataDir));
    results.push(checkWritableDirectories("文件发送白名单目录", config.fileSend.allowedDirs));
    results.push(config.codex.family.envMode === "minimal"
        ? ok("family 环境隔离", "CODEX_FAMILY_ENV_MODE=minimal")
        : fail("family 环境隔离", `CODEX_FAMILY_ENV_MODE=${config.codex.family.envMode}`));
    results.push(ok("Codex backend", `admin=${config.codex.admin.backend}, family=${config.codex.family.backend}`));
    try {
        const database = new index_js_2.AppDatabase(node_path_1.default.join(config.server.dataDir, "weixin-household-gateway.sqlite"));
        database.initialize();
        const accounts = database.listAccounts();
        const activeAccounts = accounts.filter((account) => account.status === "active");
        database.close();
        results.push(activeAccounts.length > 0
            ? ok("微信账号", `active=${activeAccounts.length}, total=${accounts.length}`)
            : fail("微信账号", `没有 active 账号，total=${accounts.length}`));
    }
    catch (error) {
        results.push(fail("SQLite", error instanceof Error ? error.message : String(error)));
    }
    results.push(await checkCommand(config.codex.admin.command, ["--version"]));
    if (config.codex.admin.codexHome) {
        results.push(ok("Codex home admin", config.codex.admin.codexHome));
    }
    if (config.codex.family.command !== config.codex.admin.command) {
        results.push(await checkCommand(config.codex.family.command, ["--version"]));
    }
    if (config.codex.family.codexHome &&
        config.codex.family.codexHome !== config.codex.admin.codexHome) {
        results.push(ok("Codex home family", config.codex.family.codexHome));
    }
    if (config.codex.admin.backend === "acp") {
        results.push(await checkAcpCommand(config.codex.admin.acpCommand));
        results.push(checkAcpAuth("Codex ACP auth admin", config.codex.admin));
        if (runAcpSession) {
            results.push(await checkAcpSession("Codex ACP session admin", config.codex.admin));
        }
    }
    if (config.codex.family.backend === "acp" &&
        config.codex.family.acpCommand !== config.codex.admin.acpCommand) {
        results.push(await checkAcpCommand(config.codex.family.acpCommand));
    }
    if (config.codex.family.backend === "acp") {
        results.push(checkAcpAuth("Codex ACP auth family", config.codex.family));
        if (runAcpSession) {
            results.push(await checkAcpSession("Codex ACP session family", config.codex.family));
        }
    }
    if (runCodex) {
        results.push(await checkCommand(config.codex.admin.command, [
            ...config.codex.admin.args,
            "请只回复：doctor-ok",
        ]));
    }
    results.push(await checkHttpHealth(config.server.port));
    const failed = results.filter((result) => !result.ok).length;
    if (outputJson) {
        console.log(JSON.stringify({ results }, null, 2));
    }
    else {
        for (const result of results) {
            console.log(`${result.ok ? "OK" : "FAIL"}  ${result.name}  ${result.detail}`);
        }
    }
    if (failed > 0) {
        process.exitCode = 1;
    }
}
void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
