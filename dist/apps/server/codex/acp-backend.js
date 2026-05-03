"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpCodexBackend = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const acp_connection_js_1 = require("./acp-connection.js");
const acp_response_collector_js_1 = require("./acp-response-collector.js");
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
class AcpCodexBackend {
    config;
    connection;
    sessions = new Map();
    persistedSessions = new Map();
    queues = new Map();
    sessionMapPath;
    constructor(config) {
        this.config = config;
        this.sessionMapPath = node_path_1.default.join(config.workspace, ".acp-session-map.json");
        this.loadPersistedSessions();
        this.connection = new acp_connection_js_1.AcpConnection(config, () => {
            this.sessions.clear();
            this.queues.clear();
        });
    }
    async run(request) {
        const previous = this.queues.get(request.conversationId) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => this.runOnce(request));
        this.queues.set(request.conversationId, next);
        try {
            return await next;
        }
        finally {
            if (this.queues.get(request.conversationId) === next) {
                this.queues.delete(request.conversationId);
            }
        }
    }
    async runOnce(request) {
        node_fs_1.default.mkdirSync(this.config.workspace, { recursive: true });
        const additionalDirectories = normalizeDirectories(request.additionalDirectories);
        const readOnlyDirectories = normalizeDirectories(request.readOnlyDirectories);
        const conn = await withTimeout(this.connection.ensureReady(), Math.min(this.config.timeoutMs, 60_000), "ACP connection timed out");
        const session = await this.getOrCreateSession(request.conversationId, conn, request.role, additionalDirectories, readOnlyDirectories);
        const collector = new acp_response_collector_js_1.AcpResponseCollector({
            ...(request.onProgress ? { onProgress: request.onProgress } : {}),
            ...(request.responseMode ? { responseMode: request.responseMode } : {}),
        });
        const promptText = session.isFresh && request.bootstrapPrompt
            ? request.bootstrapPrompt
            : request.prompt;
        const prompt = [
            {
                type: "text",
                text: promptText,
            },
        ];
        this.connection.registerCollector(session.sessionId, collector);
        try {
            const response = await withTimeout(conn.prompt({
                sessionId: session.sessionId,
                prompt,
                messageId: node_crypto_1.default.randomUUID(),
            }), this.config.timeoutMs, `ACP prompt timed out after ${this.config.timeoutMs}ms`);
            const text = collector.toText();
            return {
                text,
                stderr: response.stopReason === "end_turn"
                    ? ""
                    : [
                        `ACP stop reason: ${response.stopReason}`,
                        ...(response.stopReason === "cancelled"
                            ? [
                                this.connection.consumeLastPermissionDecision(session.sessionId) ?? "",
                            ]
                            : []),
                    ]
                        .filter(Boolean)
                        .join("\n"),
                exitCode: response.stopReason === "end_turn" ? 0 : 1,
                timedOut: false,
            };
        }
        finally {
            this.connection.unregisterCollector(session.sessionId);
        }
    }
    async getOrCreateSession(conversationId, conn, role, additionalDirectories, readOnlyDirectories) {
        const existing = this.sessions.get(conversationId);
        if (existing) {
            this.connection.setSessionPermissions(existing, {
                role,
                additionalDirectories,
                readOnlyDirectories,
            });
            return {
                sessionId: existing,
                isFresh: false,
            };
        }
        const persisted = this.persistedSessions.get(conversationId);
        const sessionAdditionalDirectories = additionalDirectories.length > 0 &&
            this.connection.supportsAdditionalDirectories()
            ? additionalDirectories
            : [];
        if (persisted && this.connection.supportsLoadSession()) {
            try {
                await withTimeout(conn.loadSession({
                    sessionId: persisted,
                    cwd: this.config.workspace,
                    mcpServers: [],
                    ...(sessionAdditionalDirectories.length > 0
                        ? { additionalDirectories: sessionAdditionalDirectories }
                        : {}),
                }), Math.min(this.config.timeoutMs, 60_000), "ACP loadSession timed out");
                console.log(`[codex:acp] loaded persisted session ${persisted} for ${conversationId}`);
                this.sessions.set(conversationId, persisted);
                this.connection.setSessionPermissions(persisted, {
                    role,
                    additionalDirectories,
                    readOnlyDirectories,
                });
                return {
                    sessionId: persisted,
                    isFresh: false,
                };
            }
            catch (error) {
                console.warn(`[codex:acp] failed to load persisted session ${persisted}; creating a new one`, error);
                this.persistedSessions.delete(conversationId);
                this.savePersistedSessions();
            }
        }
        const response = await withTimeout(conn.newSession({
            cwd: this.config.workspace,
            mcpServers: [],
            ...(sessionAdditionalDirectories.length > 0
                ? { additionalDirectories: sessionAdditionalDirectories }
                : {}),
        }), Math.min(this.config.timeoutMs, 60_000), "ACP newSession timed out");
        this.sessions.set(conversationId, response.sessionId);
        this.connection.setSessionPermissions(response.sessionId, {
            role,
            additionalDirectories,
            readOnlyDirectories,
        });
        this.persistedSessions.set(conversationId, response.sessionId);
        this.savePersistedSessions();
        return {
            sessionId: response.sessionId,
            isFresh: true,
        };
    }
    clearSession(conversationId) {
        const sessionId = this.sessions.get(conversationId);
        if (sessionId) {
            this.connection.unregisterCollector(sessionId);
            this.connection.clearSessionPermissions(sessionId);
            this.sessions.delete(conversationId);
        }
        this.persistedSessions.delete(conversationId);
        this.savePersistedSessions();
    }
    dispose() {
        this.sessions.clear();
        this.persistedSessions.clear();
        this.queues.clear();
        this.connection.dispose();
    }
    loadPersistedSessions() {
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.sessionMapPath, "utf8"));
            if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
                return;
            }
            for (const item of parsed.sessions) {
                if (item.conversationId && item.sessionId) {
                    this.persistedSessions.set(item.conversationId, item.sessionId);
                }
            }
        }
        catch {
            // Missing or invalid persisted map is not fatal; sessions can be rebuilt.
        }
    }
    savePersistedSessions() {
        node_fs_1.default.mkdirSync(this.config.workspace, { recursive: true });
        const payload = {
            version: 1,
            sessions: [...this.persistedSessions.entries()].map(([conversationId, sessionId]) => ({
                conversationId,
                sessionId,
                updatedAt: new Date().toISOString(),
            })),
        };
        node_fs_1.default.writeFileSync(this.sessionMapPath, JSON.stringify(payload, null, 2), {
            encoding: "utf8",
            mode: 0o600,
        });
    }
}
exports.AcpCodexBackend = AcpCodexBackend;
function normalizeDirectories(paths) {
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
