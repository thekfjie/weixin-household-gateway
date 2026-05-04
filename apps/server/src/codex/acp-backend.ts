import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ContentBlock, SessionId } from "@agentclientprotocol/sdk";
import { CodexRuntimeConfig, UserRole } from "../config/types.js";
import { AcpConnection } from "./acp-connection.js";
import { AcpResponseCollector } from "./acp-response-collector.js";
import { CodexBackend, CodexBackendRequest } from "./backend-types.js";
import { CodexRunResult } from "./types.js";

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

interface PersistedAcpSession {
  conversationId: string;
  sessionId: SessionId;
  updatedAt: string;
}

interface PersistedAcpSessionMap {
  version: 1;
  sessions: PersistedAcpSession[];
}

interface AcpSessionHandle {
  sessionId: SessionId;
  isFresh: boolean;
}

export class AcpCodexBackend implements CodexBackend {
  private readonly connection: AcpConnection;

  private readonly sessions = new Map<string, SessionId>();

  private readonly persistedSessions = new Map<string, SessionId>();

  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly sessionMapPath: string;

  constructor(private readonly config: CodexRuntimeConfig) {
    this.sessionMapPath = path.join(config.workspace, ".acp-session-map.json");
    this.loadPersistedSessions();
    this.connection = new AcpConnection(config, () => {
      this.sessions.clear();
      this.queues.clear();
    });
  }

  async run(request: CodexBackendRequest): Promise<CodexRunResult> {
    const previous = this.queues.get(request.conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.runOnce(request));
    this.queues.set(request.conversationId, next);

    try {
      return await next;
    } finally {
      if (this.queues.get(request.conversationId) === next) {
        this.queues.delete(request.conversationId);
      }
    }
  }

  private async runOnce(request: CodexBackendRequest): Promise<CodexRunResult> {
    fs.mkdirSync(this.config.workspace, { recursive: true });
    const additionalDirectories = normalizeDirectories(
      request.additionalDirectories,
    );
    const readOnlyDirectories = normalizeDirectories(request.readOnlyDirectories);

    const conn = await withTimeout(
      this.connection.ensureReady(),
      Math.min(this.config.timeoutMs, 60_000),
      "ACP connection timed out",
    );
    const session = await this.getOrCreateSession(
      request.conversationId,
      conn,
      request.role,
      additionalDirectories,
      readOnlyDirectories,
    );
    const collector = new AcpResponseCollector({
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      ...(request.responseMode ? { responseMode: request.responseMode } : {}),
    });
    const promptText =
      session.isFresh && request.bootstrapPrompt
        ? request.bootstrapPrompt
        : request.prompt;
    const prompt: ContentBlock[] = [
      {
        type: "text",
        text: promptText,
      },
    ];

    this.connection.registerCollector(session.sessionId, collector);
    try {
      const response = await withTimeout(
        conn.prompt({
          sessionId: session.sessionId,
          prompt,
          messageId: crypto.randomUUID(),
        }),
        this.config.timeoutMs,
        `ACP prompt timed out after ${this.config.timeoutMs}ms`,
      );
      const text = collector.toText();

      return {
        text,
        stderr:
          response.stopReason === "end_turn"
            ? ""
            : [
                `ACP stop reason: ${response.stopReason}`,
                ...(response.stopReason === "cancelled"
                  ? [
                      this.connection.consumeLastPermissionDecision(
                        session.sessionId,
                      ) ?? "",
                    ]
                  : []),
              ]
                .filter(Boolean)
                .join("\n"),
        exitCode: response.stopReason === "end_turn" ? 0 : 1,
        timedOut: false,
      };
    } finally {
      this.connection.unregisterCollector(session.sessionId);
    }
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
    role: UserRole,
    additionalDirectories: string[],
    readOnlyDirectories: string[],
  ): Promise<AcpSessionHandle> {
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
    const sessionAdditionalDirectories =
      additionalDirectories.length > 0 &&
      this.connection.supportsAdditionalDirectories()
        ? additionalDirectories
        : [];
    if (persisted && this.connection.supportsLoadSession()) {
      try {
        await withTimeout(
          conn.loadSession({
            sessionId: persisted,
            cwd: this.config.workspace,
            mcpServers: [],
            ...(sessionAdditionalDirectories.length > 0
              ? { additionalDirectories: sessionAdditionalDirectories }
              : {}),
          }),
          Math.min(this.config.timeoutMs, 60_000),
          "ACP loadSession timed out",
        );
        console.log(
          `[codex:acp] loaded persisted session ${persisted} for ${conversationId}`,
        );
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
      } catch (error) {
        console.warn(
          `[codex:acp] failed to load persisted session ${persisted}; creating a new one`,
          error,
        );
        this.persistedSessions.delete(conversationId);
        this.savePersistedSessions();
      }
    }

    const response = await withTimeout(
      conn.newSession({
        cwd: this.config.workspace,
        mcpServers: [],
        ...(sessionAdditionalDirectories.length > 0
          ? { additionalDirectories: sessionAdditionalDirectories }
          : {}),
      }),
      Math.min(this.config.timeoutMs, 60_000),
      "ACP newSession timed out",
    );
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

  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      this.connection.unregisterCollector(sessionId);
      this.connection.clearSessionPermissions(sessionId);
      this.sessions.delete(conversationId);
    }
    this.persistedSessions.delete(conversationId);
    this.savePersistedSessions();
  }

  dispose(): void {
    this.sessions.clear();
    this.persistedSessions.clear();
    this.queues.clear();
    this.connection.dispose();
  }

  private loadPersistedSessions(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.sessionMapPath, "utf8"),
      ) as PersistedAcpSessionMap;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return;
      }

      for (const item of parsed.sessions) {
        if (item.conversationId && item.sessionId) {
          this.persistedSessions.set(item.conversationId, item.sessionId);
        }
      }
    } catch {

    }
  }

  private savePersistedSessions(): void {
    fs.mkdirSync(this.config.workspace, { recursive: true });
    const payload: PersistedAcpSessionMap = {
      version: 1,
      sessions: [...this.persistedSessions.entries()].map(
        ([conversationId, sessionId]) => ({
          conversationId,
          sessionId,
          updatedAt: new Date().toISOString(),
        }),
      ),
    };

    fs.writeFileSync(this.sessionMapPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function normalizeDirectories(paths: string[] | undefined): string[] {
  if (!paths?.length) {
    return [];
  }

  return [
    ...new Set(
      paths
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    ),
  ];
}
