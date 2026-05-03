"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const VALID_CODEX_MODES = [
    "suggest",
    "auto-edit",
    "full-auto",
];
const VALID_CODEX_ENV_MODES = ["inherit", "minimal"];
const VALID_CODEX_BACKENDS = ["cli", "acp"];
const VALID_CODEX_ACP_AUTH_MODES = [
    "auto",
    "env",
    "none",
];
let dotEnvLoaded = false;
function unquoteEnvValue(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function loadDotEnvFile() {
    if (dotEnvLoaded) {
        return;
    }
    dotEnvLoaded = true;
    const envPath = node_path_1.default.resolve(".env");
    if (!node_fs_1.default.existsSync(envPath)) {
        return;
    }
    const lines = node_fs_1.default.readFileSync(envPath, "utf8").split(/\r?\n/);
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
function readEnv(name, fallback) {
    const value = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function readOptionalEnv(name, fallback) {
    const value = process.env[name]?.trim();
    return value || fallback;
}
function readBoolean(name, fallback) {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    return raw === "1" || raw.toLowerCase() === "true";
}
function readPort(name, fallback) {
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
function readMode(name, fallback) {
    const raw = (process.env[name] ?? fallback);
    if (!VALID_CODEX_MODES.includes(raw)) {
        throw new Error(`Environment variable ${name} is not a valid Codex mode: ${raw}`);
    }
    return raw;
}
function readEnvMode(name, fallback) {
    const raw = (process.env[name] ?? fallback);
    if (!VALID_CODEX_ENV_MODES.includes(raw)) {
        throw new Error(`Environment variable ${name} is not a valid Codex env mode: ${raw}`);
    }
    return raw;
}
function readBackend(name, fallback) {
    const raw = (process.env[name] ?? fallback);
    if (!VALID_CODEX_BACKENDS.includes(raw)) {
        throw new Error(`Environment variable ${name} is not a valid Codex backend: ${raw}`);
    }
    return raw;
}
function readAcpAuthMode(name, fallback) {
    const raw = (process.env[name] ?? fallback);
    if (!VALID_CODEX_ACP_AUTH_MODES.includes(raw)) {
        throw new Error(`Environment variable ${name} is not a valid Codex ACP auth mode: ${raw}`);
    }
    return raw;
}
function readPositiveInteger(name, fallback) {
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
function readNonNegativeInteger(name, fallback) {
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
function splitCommandArgs(raw) {
    const args = [];
    let current = "";
    let quote;
    let escaping = false;
    for (const char of raw) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === "\\") {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (escaping) {
        current += "\\";
    }
    if (quote) {
        throw new Error(`Unclosed quote in command args: ${raw}`);
    }
    if (current) {
        args.push(current);
    }
    return args;
}
function readArgs(name, fallback) {
    const raw = process.env[name]?.trim();
    return raw ? splitCommandArgs(raw) : fallback;
}
function readCodexArgs(name) {
    return readArgs(name, ["exec", "--skip-git-repo-check"]);
}
function readAcpArgs(name) {
    return readArgs(name, []);
}
function readPathList(name, fallback) {
    const raw = process.env[name]?.trim();
    const values = raw
        ? raw.split(node_path_1.default.delimiter).map((item) => item.trim()).filter(Boolean)
        : fallback;
    return [...new Set(values.map((item) => node_path_1.default.resolve(item)))];
}
function readNameList(name) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return [];
    }
    return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function readOptionalPath(name) {
    const raw = process.env[name]?.trim();
    return raw ? node_path_1.default.resolve(raw) : undefined;
}
function resolveDefaultCodexCommand() {
    return process.platform === "win32" ? "codex.cmd" : "codex";
}
function resolveDefaultAcpCommand() {
    const localBin = node_path_1.default.resolve("node_modules", ".bin", process.platform === "win32" ? "codex-acp.CMD" : "codex-acp");
    return node_fs_1.default.existsSync(localBin)
        ? localBin
        : process.platform === "win32"
            ? "codex-acp.cmd"
            : "codex-acp";
}
function resolveDefaultCodexWorkspace(name) {
    return name === "admin"
        ? "./runtime/codex-admin"
        : "./runtime/codex-family";
}
function loadConfig() {
    loadDotEnvFile();
    const dataDir = node_path_1.default.resolve(readEnv("DATA_DIR", "./data"));
    const routeTag = process.env.WECHAT_ROUTE_TAG?.trim() || undefined;
    const adminMode = readMode("CODEX_ADMIN_MODE", "full-auto");
    const familyMode = readMode("CODEX_FAMILY_MODE", "suggest");
    const codexBackend = readBackend("CODEX_BACKEND", "acp");
    const codexAcpAuthMode = readAcpAuthMode("CODEX_ACP_AUTH_MODE", "auto");
    const codexTimeoutMs = readPositiveInteger("CODEX_TIMEOUT_MS", 180_000);
    const fileAllowedDirs = readPathList("FILE_SEND_ALLOWED_DIRS", [
        node_path_1.default.join(dataDir, "outbox"),
        node_path_1.default.join(dataDir, "inbox"),
        node_path_1.default.join(dataDir, "office"),
        node_os_1.default.tmpdir(),
    ]);
    return {
        server: {
            port: readPort("PORT", 18080),
            timezone: readEnv("TIMEZONE", "Asia/Shanghai"),
            dataDir,
        },
        wechat: {
            apiBaseUrl: readEnv("WECHAT_API_BASE_URL", "https://ilinkai.weixin.qq.com"),
            cdnBaseUrl: readEnv("WECHAT_CDN_BASE_URL", "https://novac2c.cdn.weixin.qq.com/c2c"),
            channelVersion: readEnv("WECHAT_CHANNEL_VERSION", "weixin-household-gateway-0.1.0"),
            ...(routeTag ? { routeTag } : {}),
            typingRefreshMs: readNonNegativeInteger("WECHAT_TYPING_REFRESH_MS", 6_000),
            thinkingNoticeMs: readNonNegativeInteger("WECHAT_THINKING_NOTICE_MS", 30_000),
            replyChunkChars: readNonNegativeInteger("WECHAT_REPLY_CHUNK_CHARS", 1800),
        },
        session: {
            rotateIdleHours: readPositiveInteger("SESSION_ROTATE_IDLE_HOURS", 24),
            rotateMaxTurns: readPositiveInteger("SESSION_ROTATE_MAX_TURNS", 50),
            rotateMaxEstimatedTokens: readPositiveInteger("SESSION_ROTATE_MAX_ESTIMATED_TOKENS", 256_000),
        },
        codex: {
            admin: {
                backend: readBackend("CODEX_ADMIN_BACKEND", codexBackend),
                command: readEnv("CODEX_ADMIN_COMMAND", resolveDefaultCodexCommand()),
                args: readCodexArgs("CODEX_ADMIN_ARGS"),
                acpCommand: readOptionalEnv("CODEX_ADMIN_ACP_COMMAND", resolveDefaultAcpCommand()),
                acpArgs: readAcpArgs("CODEX_ADMIN_ACP_ARGS"),
                acpAuthMode: readAcpAuthMode("CODEX_ADMIN_ACP_AUTH_MODE", codexAcpAuthMode),
                codexHome: readOptionalPath("CODEX_ADMIN_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
                mode: adminMode,
                timeoutMs: readPositiveInteger("CODEX_ADMIN_TIMEOUT_MS", codexTimeoutMs),
                workspace: node_path_1.default.resolve(readEnv("CODEX_ADMIN_WORKSPACE", resolveDefaultCodexWorkspace("admin"))),
                envMode: readEnvMode("CODEX_ADMIN_ENV_MODE", "inherit"),
                envPassthrough: readNameList("CODEX_ADMIN_ENV_PASSTHROUGH"),
            },
            family: {
                backend: readBackend("CODEX_FAMILY_BACKEND", codexBackend),
                command: readEnv("CODEX_FAMILY_COMMAND", resolveDefaultCodexCommand()),
                args: readCodexArgs("CODEX_FAMILY_ARGS"),
                acpCommand: readOptionalEnv("CODEX_FAMILY_ACP_COMMAND", resolveDefaultAcpCommand()),
                acpArgs: readAcpArgs("CODEX_FAMILY_ACP_ARGS"),
                acpAuthMode: readAcpAuthMode("CODEX_FAMILY_ACP_AUTH_MODE", codexAcpAuthMode),
                codexHome: readOptionalPath("CODEX_FAMILY_HOME") ?? readOptionalPath("CODEX_CLI_HOME"),
                mode: familyMode,
                timeoutMs: readPositiveInteger("CODEX_FAMILY_TIMEOUT_MS", codexTimeoutMs),
                workspace: node_path_1.default.resolve(readEnv("CODEX_FAMILY_WORKSPACE", resolveDefaultCodexWorkspace("family"))),
                envMode: readEnvMode("CODEX_FAMILY_ENV_MODE", "minimal"),
                envPassthrough: readNameList("CODEX_FAMILY_ENV_PASSTHROUGH"),
            },
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
