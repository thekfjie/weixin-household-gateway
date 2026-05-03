"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpConnection = void 0;
exports.buildAcpEnv = buildAcpEnv;
exports.selectAcpAuthMethod = selectAcpAuthMethod;
exports.hasAcpEnvAuth = hasAcpEnvAuth;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_stream_1 = require("node:stream");
const sdk_1 = require("@agentclientprotocol/sdk");
const run_codex_js_1 = require("./run-codex.js");
const ACP_AUTH_ENV_KEYS = [
    "CODEX_CLI_HOME",
    "CODEX_CLI_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
];
function describeToolCall(update) {
    return update.title ?? update.kind ?? update.toolCallId ?? "tool";
}
function formatToolCallDetails(params) {
    const parts = [];
    const title = describeToolCall(params.toolCall);
    parts.push(title);
    if (params.toolCall.kind) {
        parts.push(`kind=${params.toolCall.kind}`);
    }
    const locations = params.toolCall.locations
        ?.map((item) => item.path)
        .filter((item) => Boolean(item))
        .slice(0, 4) ?? [];
    if (locations.length > 0) {
        parts.push(`paths=${locations.join(",")}`);
    }
    if (params.toolCall.content?.length) {
        const textSnippets = params.toolCall.content
            .map((item) => item.type === "content" && item.content.type === "text"
            ? item.content.text
            : undefined)
            .filter((item) => Boolean(item))
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 2);
        if (textSnippets.length > 0) {
            parts.push(`content=${textSnippets.join(" | ")}`);
        }
    }
    return parts.join(" ");
}
function defaultHome() {
    const home = node_os_1.default.homedir();
    if (home && home !== ".") {
        return home;
    }
    return process.env.HOME ?? process.env.USERPROFILE;
}
function cleanupSubprocessStdio(proc) {
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        if (stream && !stream.destroyed) {
            try {
                stream.destroy();
            }
            catch {
                // Best-effort cleanup. The process may already have closed the stream.
            }
        }
    }
}
function readCodexAuthJson(env) {
    const codexHome = env.CODEX_HOME ??
        (env.HOME ? node_path_1.default.join(env.HOME, ".codex") : undefined) ??
        (env.USERPROFILE ? node_path_1.default.join(env.USERPROFILE, ".codex") : undefined);
    if (!codexHome) {
        return {};
    }
    const authPath = node_path_1.default.join(codexHome, "auth.json");
    try {
        const parsed = JSON.parse(node_fs_1.default.readFileSync(authPath, "utf8"));
        const result = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string" && value) {
                result[key] = value;
            }
        }
        return result;
    }
    catch {
        return {};
    }
}
function buildAcpEnv(config) {
    const env = { ...(0, run_codex_js_1.buildChildEnv)(config) };
    for (const key of ACP_AUTH_ENV_KEYS) {
        env[key] ??= process.env[key];
    }
    const configuredCodexHome = config.codexHome ?? env.CODEX_HOME ?? env.CODEX_CLI_HOME;
    if (configuredCodexHome) {
        env.CODEX_HOME = node_path_1.default.resolve(configuredCodexHome);
    }
    const home = env.HOME ?? env.USERPROFILE ?? defaultHome();
    if (home) {
        env.HOME ??= home;
        env.USERPROFILE ??= home;
        env.CODEX_HOME ??= node_path_1.default.join(home, ".codex");
    }
    const codexAuth = readCodexAuthJson(env);
    const apiKey = env.CODEX_CLI_API_KEY ??
        env.OPENAI_API_KEY ??
        env.CODEX_API_KEY ??
        codexAuth.OPENAI_API_KEY ??
        codexAuth.CODEX_API_KEY;
    env.OPENAI_API_KEY ??= apiKey;
    env.CODEX_API_KEY ??= apiKey;
    return env;
}
function authMethodType(method) {
    return "type" in method && method.type ? method.type : "agent";
}
function isEnvAuthMethod(method) {
    return "type" in method && method.type === "env_var";
}
function selectAcpAuthMethod(methods, env) {
    if (!methods?.length) {
        return undefined;
    }
    const readyEnvMethod = methods.find((method) => {
        if (!isEnvAuthMethod(method)) {
            return false;
        }
        return method.vars.every((variable) => {
            if (variable.optional) {
                return true;
            }
            return Boolean(env[variable.name]);
        });
    });
    if (readyEnvMethod) {
        return readyEnvMethod;
    }
    return undefined;
}
function hasAcpEnvAuth(config) {
    const env = buildAcpEnv(config);
    return Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);
}
function describeAuthMethods(methods, env) {
    if (!methods?.length) {
        return "none";
    }
    return methods
        .map((method) => {
        const type = authMethodType(method);
        if (!isEnvAuthMethod(method)) {
            return `${method.id}:${type}`;
        }
        const vars = method.vars
            .map((variable) => `${variable.name}=${Boolean(env[variable.name])}`)
            .join(",");
        return `${method.id}:${type}[${vars}]`;
    })
        .join(" ");
}
function requiredAuthEnvVars(methods) {
    const names = new Set();
    for (const method of methods ?? []) {
        if (!isEnvAuthMethod(method)) {
            continue;
        }
        for (const variable of method.vars) {
            if (!variable.optional) {
                names.add(variable.name);
            }
        }
    }
    return [...names].sort();
}
function normalizePathList(paths) {
    if (!paths?.length) {
        return [];
    }
    return [
        ...new Set(paths
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => node_path_1.default.resolve(item))),
    ];
}
function isInsideDirectory(filePath, directory) {
    const relative = node_path_1.default.relative(directory, filePath);
    return (relative === "" ||
        (!!relative && !relative.startsWith("..") && !node_path_1.default.isAbsolute(relative)));
}
function extractPathsFromRawInput(value) {
    if (!value || typeof value !== "object") {
        return [];
    }
    const result = [];
    const pushIfPath = (candidate) => {
        if (typeof candidate === "string" && candidate.trim()) {
            const trimmed = candidate.trim();
            if (node_path_1.default.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
                result.push(node_path_1.default.resolve(trimmed));
            }
        }
    };
    for (const [key, candidate] of Object.entries(value)) {
        if (key === "path" ||
            key === "cwd" ||
            key.endsWith("Path") ||
            key.endsWith("_path")) {
            pushIfPath(candidate);
            continue;
        }
        if ((key === "paths" || key.endsWith("Paths") || key.endsWith("_paths")) &&
            Array.isArray(candidate)) {
            for (const item of candidate) {
                pushIfPath(item);
            }
        }
    }
    return [...new Set(result)];
}
function choosePermissionOption(options, preferredKinds) {
    for (const option of options) {
        if (preferredKinds.has(option.kind)) {
            return option;
        }
    }
    return options[0];
}
function decidePermission(config, context, params) {
    const allowedRoots = normalizePathList([
        config.workspace,
        ...(context?.additionalDirectories ?? []),
    ]);
    const readOnlyRoots = normalizePathList(context?.readOnlyDirectories);
    const touchedPaths = [
        ...(params.toolCall.locations?.map((item) => item.path) ?? []),
        ...extractPathsFromRawInput(params.toolCall.rawInput),
    ]
        .filter(Boolean)
        .map((item) => node_path_1.default.resolve(item));
    const kind = params.toolCall.kind ?? "other";
    const describeRoots = allowedRoots.join(", ") || config.workspace;
    const allowKinds = new Set(["allow_once", "allow_always"]);
    const rejectKinds = new Set(["reject_once", "reject_always"]);
    if (kind === "read") {
        if (touchedPaths.length > 0 &&
            touchedPaths.every((item) => allowedRoots.some((root) => isInsideDirectory(item, root)))) {
            const option = choosePermissionOption(params.options, allowKinds);
            if (option) {
                return {
                    allowed: true,
                    reason: `allow read inside ${describeRoots}`,
                    optionId: option.optionId,
                };
            }
        }
    }
    if (kind === "edit" || kind === "move" || kind === "delete") {
        if (touchedPaths.length > 0 &&
            touchedPaths.every((item) => allowedRoots.some((root) => isInsideDirectory(item, root)) &&
                !readOnlyRoots.some((root) => isInsideDirectory(item, root)))) {
            const option = choosePermissionOption(params.options, allowKinds);
            if (option) {
                return {
                    allowed: true,
                    reason: `allow ${kind} inside writable session workspace`,
                    optionId: option.optionId,
                };
            }
        }
    }
    if (kind === "execute") {
        const contentText = params.toolCall.content
            ?.map((item) => item.type === "content" && item.content.type === "text"
            ? item.content.text
            : "")
            .join("\n")
            .toLowerCase() ?? "";
        const looksLocalProcessing = /(unzip\b|python\b|python3\b|node\b|pandoc\b|ffmpeg\b|magick\b|convert\b|file\b|ls\b|cat\b|grep\b|rg\b|find\b|sed\b)/.test(contentText);
        if (looksLocalProcessing &&
            touchedPaths.length > 0 &&
            touchedPaths.every((item) => allowedRoots.some((root) => isInsideDirectory(item, root)))) {
            const option = choosePermissionOption(params.options, allowKinds);
            if (option) {
                return {
                    allowed: true,
                    reason: "allow local processing command inside controlled workspace",
                    optionId: option.optionId,
                };
            }
        }
    }
    const rejectOption = choosePermissionOption(params.options, rejectKinds);
    return {
        allowed: false,
        reason: touchedPaths.length > 0
            ? `blocked ${kind} outside controlled workspace`
            : `blocked ${kind}; no safe path scope detected`,
        ...(rejectOption ? { optionId: rejectOption.optionId } : {}),
    };
}
class AcpConnection {
    config;
    onExit;
    process;
    connection;
    ready = false;
    loadSessionSupported = false;
    additionalDirectoriesSupported = false;
    collectors = new Map();
    sessionPermissions = new Map();
    lastPermissionDecisionBySession = new Map();
    constructor(config, onExit) {
        this.config = config;
        this.onExit = onExit;
    }
    registerCollector(sessionId, collector) {
        this.collectors.set(sessionId, collector);
    }
    unregisterCollector(sessionId) {
        this.collectors.delete(sessionId);
    }
    setSessionPermissions(sessionId, context) {
        this.sessionPermissions.set(sessionId, {
            additionalDirectories: normalizePathList(context.additionalDirectories),
            readOnlyDirectories: normalizePathList(context.readOnlyDirectories),
        });
    }
    clearSessionPermissions(sessionId) {
        this.sessionPermissions.delete(sessionId);
        this.lastPermissionDecisionBySession.delete(sessionId);
    }
    consumeLastPermissionDecision(sessionId) {
        const message = this.lastPermissionDecisionBySession.get(sessionId);
        if (message) {
            this.lastPermissionDecisionBySession.delete(sessionId);
        }
        return message;
    }
    async ensureReady() {
        if (this.ready && this.connection) {
            return this.connection;
        }
        const env = buildAcpEnv(this.config);
        const acpArgs = [...this.config.acpArgs];
        if (this.config.roleOverrides?.model) {
            acpArgs.push("-c", `model=${JSON.stringify(this.config.roleOverrides.model)}`);
        }
        if (this.config.roleOverrides?.reasoningEffort) {
            acpArgs.push("-c", `model_reasoning_effort=${JSON.stringify(this.config.roleOverrides.reasoningEffort)}`);
        }
        const proc = (0, node_child_process_1.spawn)(this.config.acpCommand, acpArgs, {
            cwd: this.config.workspace,
            env,
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "inherit"],
        });
        this.process = proc;
        const subprocessError = new Promise((_resolve, reject) => {
            proc.once("error", (error) => {
                cleanupSubprocessStdio(proc);
                reject(error);
            });
        });
        proc.once("exit", (code) => {
            console.warn(`[codex:acp] subprocess exited: ${code ?? "unknown"}`);
            cleanupSubprocessStdio(proc);
            this.ready = false;
            this.loadSessionSupported = false;
            this.additionalDirectoriesSupported = false;
            this.connection = undefined;
            this.process = undefined;
            this.collectors.clear();
            this.sessionPermissions.clear();
            this.lastPermissionDecisionBySession.clear();
            this.onExit();
        });
        if (!proc.stdin || !proc.stdout) {
            throw new Error("ACP subprocess did not expose stdio pipes");
        }
        const writable = node_stream_1.Writable.toWeb(proc.stdin);
        const readable = node_stream_1.Readable.toWeb(proc.stdout);
        const stream = (0, sdk_1.ndJsonStream)(writable, readable);
        const conn = new sdk_1.ClientSideConnection((_agent) => ({
            sessionUpdate: async (params) => {
                const update = params.update;
                switch (update.sessionUpdate) {
                    case "tool_call":
                        console.log(`[codex:acp] tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`);
                        break;
                    case "tool_call_update":
                        if (update.status) {
                            console.log(`[codex:acp] tool_call_update: ${describeToolCall(update)} -> ${update.status}`);
                        }
                        break;
                    case "agent_thought_chunk":
                        // Do not forward internal thinking to WeChat.
                        break;
                }
                this.collectors.get(params.sessionId)?.handleUpdate(params);
            },
            requestPermission: async (params) => {
                const decision = decidePermission(this.config, this.sessionPermissions.get(params.sessionId), params);
                const detail = formatToolCallDetails(params);
                this.lastPermissionDecisionBySession.set(params.sessionId, `${decision.reason}: ${detail}`);
                if (decision.allowed && decision.optionId) {
                    console.log(`[codex:acp] permission request allowed: ${decision.reason}: ${detail}`);
                    return {
                        outcome: {
                            outcome: "selected",
                            optionId: decision.optionId,
                        },
                    };
                }
                console.warn(`[codex:acp] permission request denied: ${decision.reason}: ${detail}`);
                return {
                    outcome: {
                        ...(decision.optionId
                            ? { outcome: "selected", optionId: decision.optionId }
                            : { outcome: "cancelled" }),
                    },
                };
            },
        }), stream);
        const initializeResponse = await Promise.race([
            conn.initialize({
                protocolVersion: sdk_1.PROTOCOL_VERSION,
                clientInfo: {
                    name: "weixin-household-gateway",
                    version: "0.1.0",
                },
                clientCapabilities: {},
            }),
            subprocessError,
        ]);
        const authMethods = initializeResponse.authMethods ?? [];
        this.loadSessionSupported =
            initializeResponse.agentCapabilities?.loadSession === true;
        this.additionalDirectoriesSupported =
            Boolean(initializeResponse.agentCapabilities?.sessionCapabilities
                ?.additionalDirectories);
        console.log(`[codex:acp] auth methods: ${describeAuthMethods(authMethods, env)}`);
        console.log(`[codex:acp] loadSession=${this.loadSessionSupported}, additionalDirectories=${this.additionalDirectoriesSupported}`);
        const authMethod = this.config.acpAuthMode === "none"
            ? undefined
            : selectAcpAuthMethod(authMethods, env);
        if (authMethod) {
            await Promise.race([
                conn.authenticate({ methodId: authMethod.id }),
                subprocessError,
            ]);
            console.log(`[codex:acp] authenticated with ${authMethod.name} (${authMethod.id})`);
        }
        else if (authMethods.length > 0 && this.config.acpAuthMode === "env") {
            const required = requiredAuthEnvVars(authMethods).join(" or ");
            throw new Error(`Set ${required || "OPENAI_API_KEY or CODEX_API_KEY"} in the service environment for codex-acp`);
        }
        else if (authMethods.length > 0) {
            console.log(`[codex:acp] skipping explicit authenticate (CODEX_*_ACP_AUTH_MODE=${this.config.acpAuthMode}); relying on agent login state`);
        }
        this.connection = conn;
        this.ready = true;
        return conn;
    }
    dispose() {
        this.ready = false;
        this.loadSessionSupported = false;
        this.additionalDirectoriesSupported = false;
        this.collectors.clear();
        this.sessionPermissions.clear();
        this.lastPermissionDecisionBySession.clear();
        this.connection = undefined;
        if (this.process) {
            const proc = this.process;
            cleanupSubprocessStdio(proc);
            proc.kill();
            this.process = undefined;
        }
    }
    supportsLoadSession() {
        return this.loadSessionSupported;
    }
    supportsAdditionalDirectories() {
        return this.additionalDirectoriesSupported;
    }
}
exports.AcpConnection = AcpConnection;
