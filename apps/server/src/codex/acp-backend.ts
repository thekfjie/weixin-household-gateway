import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ContentBlock, SessionId } from "@agentclientprotocol/sdk";
import { CodexRuntimeConfig, UserRole } from "../config/types.js";
import { AcpConnection } from "./acp-connection.js";
import { AcpResponseCollector } from "./acp-response-collector.js";
import { CodexBackend, CodexBackendRequest } from "./backend-types.js";
import { CodexRunResult } from "./types.js";

class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
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
      timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
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
      request.persistentSession !== false,
      additionalDirectories,
      readOnlyDirectories,
    );
    const collector = new AcpResponseCollector({
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      ...(request.responseMode ? { responseMode: request.responseMode } : {}),
    });
    const turnPromptText =
      session.isFresh && request.bootstrapPrompt
        ? request.bootstrapPrompt
        : request.prompt;
    const promptText = [request.systemPrompt, turnPromptText]
      .filter(Boolean)
      .join("\n\n");
    const prompt: ContentBlock[] = [
      {
        type: "text",
        text: promptText,
      },
    ];

    this.connection.registerCollector(session.sessionId, collector);
    try {
      const promptRequest = {
        sessionId: session.sessionId,
        prompt,
        messageId: crypto.randomUUID(),
      };
      const promptPromise = conn.prompt(promptRequest);
      let timedOut = false;
      let response: Awaited<typeof promptPromise>;
      try {
        response = await withTimeout(
          promptPromise,
          this.config.timeoutMs,
          `ACP prompt timed out after ${this.config.timeoutMs}ms`,
        );
      } catch (error) {
        if (!(error instanceof OperationTimeoutError)) {
          throw error;
        }

        timedOut = true;
        try {
          await conn.cancel({ sessionId: session.sessionId });
        } catch (cancelError) {
          console.warn("[codex:acp] failed to cancel timed out prompt", cancelError);
        }

        try {
          response = await withTimeout(
            promptPromise,
            15_000,
            `ACP prompt did not acknowledge cancel after timeout`,
          );
        } catch (cancelWaitError) {
          const text = collector.toText();
          this.resetConnectionAfterStuckPrompt(request.conversationId);
          return {
            text,
            stderr: [
              `ACP prompt timed out after ${this.config.timeoutMs}ms`,
              cancelWaitError instanceof Error
                ? cancelWaitError.message
                : String(cancelWaitError),
            ]
              .filter(Boolean)
              .join("\n"),
            exitCode: text.trim() ? 0 : 1,
            timedOut: true,
          };
        }
      }
      const text = collector.toText();

      return {
        text,
        stderr: buildAcpStderr({
          stopReason: response.stopReason,
          timedOut,
          timeoutMs: this.config.timeoutMs,
          permissionDecision:
            response.stopReason === "cancelled"
              ? this.connection.consumeLastPermissionDecision(session.sessionId)
              : undefined,
        }),
        exitCode:
          response.stopReason === "end_turn" || (timedOut && text.trim())
            ? 0
            : 1,
        timedOut,
      };
    } finally {
      this.connection.unregisterCollector(session.sessionId);
    }
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
    role: UserRole,
    persistentSession: boolean,
    additionalDirectories: string[],
    readOnlyDirectories: string[],
  ): Promise<AcpSessionHandle> {
    if (!persistentSession) {
      const response = await withTimeout(
        conn.newSession({
          cwd: this.config.workspace,
          mcpServers: [],
          ...(additionalDirectories.length > 0 &&
          this.connection.supportsAdditionalDirectories()
            ? { additionalDirectories }
            : {}),
        }),
        Math.min(this.config.timeoutMs, 60_000),
        "ACP newSession timed out",
      );
      this.connection.setSessionPermissions(response.sessionId, {
        role,
        additionalDirectories,
        readOnlyDirectories,
      });
      return {
        sessionId: response.sessionId,
        isFresh: true,
      };
    }

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

  private resetConnectionAfterStuckPrompt(conversationId: string): void {
    this.sessions.clear();
    this.persistedSessions.delete(conversationId);
    this.savePersistedSessions();
    this.connection.dispose();
  }
}

function buildAcpStderr(params: {
  stopReason: string;
  timedOut: boolean;
  timeoutMs: number;
  permissionDecision?: string | undefined;
}): string {
  const lines: string[] = [];
  if (params.timedOut) {
    lines.push(`ACP prompt timed out after ${params.timeoutMs}ms`);
  }

  if (params.stopReason !== "end_turn") {
    lines.push(`ACP stop reason: ${params.stopReason}`);
  }

  if (params.stopReason === "cancelled" && params.permissionDecision) {
    lines.push(params.permissionDecision);
  }

  return lines.filter(Boolean).join("\n");
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
