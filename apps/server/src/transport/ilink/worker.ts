import crypto from "node:crypto";
import {
  AppConfig,
  CodexRuntimeConfig,
  isCodexReasoningEffort,
  UserRole,
} from "../../config/index.js";
import {
  parseBuiltInCommand,
  parseNaturalFileRequest,
  buildCommandReply,
} from "../../commands/index.js";
import {
  CodexBackend,
  CodexProgressEvent,
  CodexResponseMode,
  buildApiSystemPrompt,
  buildCodexPromptSet,
  createCodexBackend,
} from "../../codex/index.js";
import {
  filterFamilyOutput,
} from "../../policy/index.js";
import { resolveRole } from "../../router/index.js";
import {
  createNextSession,
  ensureSessionWorkspaceDirs,
  ensureActiveSession,
  parseSessionMemory,
  PendingInboundAttachment,
  stringifySessionMemory,
  estimateTextTokens,
  shouldRotateByThresholds,
  buildDayChangeUserNotice,
  summarizeCarryoverContext,
  buildDeterministicSessionSummary,
} from "../../sessions/index.js";
import {
  AppDatabase,
  SessionRecord,
  WechatAccountRecord,
} from "../../storage/index.js";
import { sendTextMessage } from "./media.js";
import { ILinkApiClient } from "./api-client.js";
import {
  buildAttachmentPromptBlock,
  buildInboundAttachmentAckPlaceholders,
  buildMediaAckReply,
  downloadInboundAttachments,
} from "./attachments.js";
import {
  normalizeInboundWechatMessages,
} from "./inbound.js";
import {
  splitReplyText,
  buildCodexErrorReply,
  buildCommandErrorReply,
  buildThinkingNoticeText,
} from "./reply.js";
import { withTypingIndicator } from "./typing.js";
import { handleAssistantFileActions, handleFileCommand } from "./file-command.js";
import { sleep } from "../../utils/index.js";
import { decideFamilyBackend } from "./routing.js";
import { buildApiInputParts } from "./api-input.js";

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function buildFamilyAcpHandoff(params: {
  session: SessionRecord;
  database: AppDatabase;
  userText: string;
  attachments: PendingInboundAttachment[];
}): string {
  const normalizedUserText = params.userText.trim();
  const recentTurns = params.database
    .listSessionMessages(params.session.id, 4)
    .reverse()
    .filter((message) => message.textContent?.trim())
    .filter((message, index, messages) => {
      if (
        index === messages.length - 1 &&
        message.direction === "inbound" &&
        message.textContent?.trim() === normalizedUserText
      ) {
        return false;
      }

      return true;
    })
    .map((message) => {
      const speaker = message.direction === "inbound" ? "User" : "Assistant";
      return `${speaker}: ${message.textContent?.trim() ?? ""}`;
    });

  const attachmentSummary = buildAttachmentPromptBlock(params.attachments);
  return [
    recentTurns.length > 0 ? `Recent context:\n${recentTurns.join("\n")}` : "",
    attachmentSummary ? `Files for this task:\n${attachmentSummary}` : "",
    `Current request:\n${params.userText.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function buildCodexReply(params: {
  backend: CodexBackend;
  backendKind: CodexRuntimeConfig["backend"];
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
  attachments: PendingInboundAttachment[];
  persistentContext: boolean;
  includeRecentTurns?: boolean;
  responseMode?: CodexResponseMode;
  onProgress?: (event: CodexProgressEvent) => void;
}): Promise<string> {
  const promptSet = buildCodexPromptSet({
    config: params.config,
    database: params.database,
    role: params.role,
    session: params.session,
    userText: params.userText,
    persistentContext: params.persistentContext,
    ...(params.includeRecentTurns !== undefined
      ? { includeRecentTurns: params.includeRecentTurns }
      : {}),
  });
  const result = await params.backend.run({
    conversationId: params.session.id,
    prompt: params.backendKind === "api" ? params.userText : promptSet.prompt,
    ...(promptSet.systemPrompt ? { systemPrompt: promptSet.systemPrompt } : {}),
    ...(params.backendKind === "api"
      ? {
          systemPrompt:
            promptSet.systemPrompt ?? buildApiSystemPrompt(params.role),
          inputParts: buildApiInputParts({
            database: params.database,
            session: params.session,
            userText: params.userText,
            attachments: params.attachments,
          }),
          promptCacheKey: `wechat:${params.role}:${params.session.id}`,
        }
      : {}),
    ...(promptSet.bootstrapPrompt
      ? { bootstrapPrompt: promptSet.bootstrapPrompt }
      : {}),
    persistentSession: params.persistentContext,
    role: params.role,
    additionalDirectories: promptSet.additionalDirectories,
    readOnlyDirectories: promptSet.readOnlyDirectories,
    ...(params.responseMode ? { responseMode: params.responseMode } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });

  if (result.timedOut) {
    throw new Error("Codex timed out");
  }

  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.text, `exit code ${result.exitCode}`]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`Codex failed: ${detail}`);
  }

  if (!result.text.trim()) {
    throw new Error(result.stderr || "Codex returned an empty response");
  }

  return result.text;
}

export interface WechatWorkerOptions {
  config: AppConfig;
  database: AppDatabase;
}

export class WechatWorker {
  private running = false;

  private loopPromise: Promise<void> | undefined;

  private codexBackends: Record<"admin" | "family-acp" | "family-api", CodexBackend>;

  constructor(private readonly options: WechatWorkerOptions) {
    this.codexBackends = {
      admin: createCodexBackend(
        this.buildRuntimeCodexConfig("admin"),
      ),
      "family-acp": createCodexBackend(
        this.buildRuntimeCodexConfig("family", { backendOverride: "acp" }),
      ),
      "family-api": createCodexBackend(
        this.buildRuntimeCodexConfig("family", { backendOverride: "api" }),
      ),
    };
  }

  private buildRuntimeCodexConfig(
    role: UserRole,
    options?: { backendOverride?: CodexRuntimeConfig["backend"] },
  ) {
    const baseConfig = this.options.config.codex[role];
    const settings = this.options.database.getCodexRoleSettings(role);
    return {
      ...baseConfig,
      ...(options?.backendOverride
        ? { backend: options.backendOverride }
        : {}),
      ...(settings?.model || settings?.reasoningEffort
        ? {
            roleOverrides: {
              ...(settings?.model ? { model: settings.model } : {}),
              ...(settings?.reasoningEffort &&
              isCodexReasoningEffort(settings.reasoningEffort)
                ? { reasoningEffort: settings.reasoningEffort }
                : {}),
            },
          }
        : {}),
    };
  }

  private rebuildCodexBackend(role: UserRole): void {
    if (role === "admin") {
      this.codexBackends.admin.dispose();
      this.codexBackends.admin = createCodexBackend(
        this.buildRuntimeCodexConfig("admin"),
      );
      return;
    }

    this.codexBackends["family-acp"].dispose();
    this.codexBackends["family-api"].dispose();
    this.codexBackends["family-acp"] = createCodexBackend(
      this.buildRuntimeCodexConfig("family", { backendOverride: "acp" }),
    );
    this.codexBackends["family-api"] = createCodexBackend(
      this.buildRuntimeCodexConfig("family", { backendOverride: "api" }),
    );
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.codexBackends.admin.dispose();
    this.codexBackends["family-acp"].dispose();
    this.codexBackends["family-api"].dispose();
  }

  private getBackendForTurn(params: {
    role: UserRole;
    userText: string;
    attachments: PendingInboundAttachment[];
  }): {
    backend: CodexBackend;
    backendKind: CodexRuntimeConfig["backend"];
    persistentSession: boolean;
  } {
    if (params.role === "admin") {
      return {
        backend: this.codexBackends.admin,
        backendKind: "acp",
        persistentSession: true,
      };
    }

    const decision = decideFamilyBackend({
      userText: params.userText,
      attachments: params.attachments,
    });

    const familyApiConfig = this.buildRuntimeCodexConfig("family", {
      backendOverride: "api",
    });
    const canUseFamilyApi = Boolean(
      familyApiConfig.apiBaseUrl && familyApiConfig.apiKey,
    );

    if (decision.backend === "acp" || !canUseFamilyApi) {
      return {
        backend: this.codexBackends["family-acp"],
        backendKind: "acp",
        persistentSession: false,
      };
    }

    return {
      backend: this.codexBackends["family-api"],
      backendKind: "api",
      persistentSession: false,
    };
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const accounts = this.options.database
        .listAccounts()
        .filter((account) => account.status === "active");

      if (accounts.length === 0) {
        await sleep(2_000);
        continue;
      }

      for (const account of accounts) {
        if (!this.running) {
          return;
        }

        try {
          await this.pollAccount(account);
        } catch (error) {
          console.error(`[worker] failed to poll ${account.id}`, error);
          await sleep(1_000);
        }
      }
    }
  }

  private async pollAccount(account: WechatAccountRecord): Promise<void> {
    const client = new ILinkApiClient({
      baseUrl: account.baseUrl ?? this.options.config.wechat.apiBaseUrl,
      cdnBaseUrl: this.options.config.wechat.cdnBaseUrl,
      channelVersion: this.options.config.wechat.channelVersion,
      ...(this.options.config.wechat.routeTag
        ? { routeTag: this.options.config.wechat.routeTag }
        : {}),
      token: account.authToken,
    });

    const cursor = this.options.database.getPollingCursor(account.id) ?? "";
    const response = await client.getUpdates(cursor);

    if (response.get_updates_buf) {
      this.options.database.savePollingCursor(
        account.id,
        response.get_updates_buf,
      );
    }

    const inboundMessages = normalizeInboundWechatMessages({
      wechatAccountId: account.id,
      messages: response.msgs ?? [],
    });

    for (const inbound of inboundMessages) {
      await this.handleInboundMessage(account, client, inbound);
    }
  }

  private async handleInboundMessage(
    account: WechatAccountRecord,
    client: ILinkApiClient,
    inbound: ReturnType<typeof normalizeInboundWechatMessages>[number],
  ): Promise<void> {
    const accountRoute = resolveRole({ configuredRole: account.role });
    const session = ensureActiveSession({
      database: this.options.database,
      wechatAccountId: inbound.wechatAccountId,
      contactId: inbound.contactId,
      role: accountRoute.role,
    });
    const existingSessionMemory = parseSessionMemory(session.memoryJson);
    const route: { role: UserRole } =
      existingSessionMemory.routeMode === "admin" ||
      existingSessionMemory.routeMode === "family"
        ? { role: existingSessionMemory.routeMode }
        : { role: accountRoute.role };
    const recentMessagesForCarryover = this.options.database
      .listSessionMessages(session.id, 12)
      .reverse();
    const archivedSummary =
      buildDeterministicSessionSummary({
        session,
        recentMessages: recentMessagesForCarryover,
      }) || session.summaryText;
    const carryoverSummary = summarizeCarryoverContext({
      session,
      recentMessages: recentMessagesForCarryover,
    });
    const rotateDecision = shouldRotateByThresholds({
      session,
      memory: existingSessionMemory,
      config: this.options.config,
    });
    const sessionForTurn = rotateDecision.shouldRotate
        ? createNextSession({
          database: this.options.database,
          previousSession: session,
          role: route.role,
          summaryText: archivedSummary,
          memoryJson: stringifySessionMemory({
            ...(existingSessionMemory.routeMode
              ? { routeMode: existingSessionMemory.routeMode }
              : {}),
            ...(carryoverSummary
              ? {
                  carryoverSummary,
                  carryoverSourceSessionId: session.id,
                  carryoverSourceLastActiveAt: session.lastActiveAt,
                }
              : {}),
          }),
          contextToken: inbound.contextToken,
          lastActiveAt: inbound.receivedAt,
        })
      : session;
    const dayChangeNotice =
      rotateDecision.shouldRotate &&
      rotateDecision.reason === "crossed into a new Beijing calendar day"
        ? buildDayChangeUserNotice({
            session,
            role: route.role,
            now: new Date(),
          })
        : undefined;

    const activeSession = this.options.database.saveSession({
      id: sessionForTurn.id,
      wechatAccountId: sessionForTurn.wechatAccountId,
      contactId: sessionForTurn.contactId,
      role: route.role,
      status: sessionForTurn.status,
      summaryText: sessionForTurn.summaryText,
      memoryJson: sessionForTurn.memoryJson,
      contextToken: inbound.contextToken,
      lastActiveAt: inbound.receivedAt,
    });
    ensureSessionWorkspaceDirs({
      config: this.options.config,
      sessionId: activeSession.id,
    });
    const sessionMemory = parseSessionMemory(activeSession.memoryJson);
    if (inbound.attachments.length > 0 && !inbound.text.trim()) {
      const ack = buildMediaAckReply({
        role: route.role,
        attachments: buildInboundAttachmentAckPlaceholders(inbound.attachments),
      });
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: ack,
      });
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: ack,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
    }
    const downloadedAttachments =
      inbound.attachments.length > 0
        ? await downloadInboundAttachments({
            attachments: inbound.attachments,
            config: this.options.config,
            client,
            database: this.options.database,
            session: activeSession,
            sourceMessageId: inbound.sourceMessageId,
            receivedAt: inbound.receivedAt,
          })
        : [];

    this.options.database.appendMessage({
      id: buildMessageId("inbound"),
      sessionId: activeSession.id,
      direction: "inbound",
      messageType: downloadedAttachments.length > 0 ? "mixed" : "text",
      textContent: [inbound.mediaSummary, inbound.text].filter(Boolean).join("\n"),
      createdAt: inbound.receivedAt,
      sourceMessageId: inbound.sourceMessageId,
    });

    if (downloadedAttachments.length > 0 && !inbound.text.trim()) {
      const nextMemory = stringifySessionMemory({
        ...sessionMemory,
        turnCount: (sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          (sessionMemory.estimatedTokenCount ?? 0) +
          estimateTextTokens([inbound.mediaSummary, inbound.text].filter(Boolean).join("\n")),
        pendingInboundAttachments: [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ].slice(-10),
      });
      const nextSession = this.options.database.saveSession({
        id: activeSession.id,
        wechatAccountId: activeSession.wechatAccountId,
        contactId: activeSession.contactId,
        role: route.role,
        status: activeSession.status,
        summaryText: activeSession.summaryText,
        memoryJson: nextMemory,
        contextToken: activeSession.contextToken,
        lastActiveAt: activeSession.lastActiveAt,
      });
      if (downloadedAttachments.some((attachment) => attachment.downloadStatus === "failed")) {
        const failureAck = buildMediaAckReply({
          role: route.role,
          attachments: downloadedAttachments,
        });
        const clientId = await sendTextMessage({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          text: failureAck,
        });
        this.options.database.appendMessage({
          id: buildMessageId("outbound"),
          sessionId: nextSession.id,
          direction: "outbound",
          messageType: "text",
          textContent: failureAck,
          createdAt: new Date().toISOString(),
          sourceMessageId: clientId || inbound.sourceMessageId,
        });
      }
      return;
    }

    const parsedCommand =
      parseBuiltInCommand(inbound.text) ??
      parseNaturalFileRequest(inbound.text);
    const pendingAttachments = parsedCommand
      ? downloadedAttachments
      : [
          ...(sessionMemory.pendingInboundAttachments ?? []),
          ...downloadedAttachments,
        ];
    const userTextForCodex =
      pendingAttachments.length > 0
        ? `${buildAttachmentPromptBlock(pendingAttachments)}\n\n用户这次的文字要求：\n${inbound.text}`
        : inbound.text;
    const sessionForReply =
      pendingAttachments.length > 0 && !parsedCommand
        ? this.options.database.saveSession({
            id: activeSession.id,
            wechatAccountId: activeSession.wechatAccountId,
            contactId: activeSession.contactId,
            role: route.role,
            status: activeSession.status,
            summaryText: activeSession.summaryText,
            memoryJson: stringifySessionMemory({
              ...sessionMemory,
              pendingInboundAttachments: [],
            }),
            contextToken: activeSession.contextToken,
            lastActiveAt: activeSession.lastActiveAt,
          })
        : activeSession;

    let rawReply: string;

    if (parsedCommand) {
      try {
        if (
          parsedCommand.name === "/new" ||
          parsedCommand.name === "/reset" ||
          parsedCommand.name === "/clear"
        ) {
          if (route.role === "admin") {
            this.codexBackends.admin.clearSession(activeSession.id);
          } else {
            this.codexBackends["family-acp"].clearSession(activeSession.id);
            this.codexBackends["family-api"].clearSession(activeSession.id);
          }
        }

        rawReply =
          parsedCommand.name === "/file" || parsedCommand.name === "/sendfile"
            ? await handleFileCommand({
                command: parsedCommand,
                config: this.options.config,
                client,
                database: this.options.database,
                session: sessionForReply,
                role: route.role,
              })
            : buildCommandReply({
                command: parsedCommand,
                session: sessionForReply,
                database: this.options.database,
                role: route.role,
                accountRole: accountRoute.role,
                sessionMemory: sessionMemory,
                account,
                config: this.options.config,
                onRoleModeChanged: () => {
                  this.codexBackends.admin.clearSession(activeSession.id);
                  this.codexBackends["family-acp"].clearSession(activeSession.id);
                  this.codexBackends["family-api"].clearSession(activeSession.id);
                },
                onCodexSettingsChanged: (changedRole) => {
                  this.rebuildCodexBackend(changedRole);
                },
              });
      } catch (error) {
        console.error("[worker] command failed", error);
        rawReply = buildCommandErrorReply({
          error,
          role: route.role,
        });
      }
    } else {
      try {
        const progress: CodexProgressEvent = { phase: "thinking" };
        const backendForTurn = this.getBackendForTurn({
          role: route.role,
          userText: inbound.text,
          attachments: pendingAttachments,
        });
        const codexUserText =
          route.role === "family" && backendForTurn.backendKind === "acp"
            ? buildFamilyAcpHandoff({
                session: sessionForReply,
                database: this.options.database,
                userText: inbound.text,
                attachments: pendingAttachments,
              })
            : backendForTurn.backendKind === "api"
              ? inbound.text
              : userTextForCodex;
        rawReply = await withTypingIndicator({
          client,
          toUserId: inbound.contactId,
          contextToken: inbound.contextToken,
          typingRefreshMs: this.options.config.wechat.typingRefreshMs,
          thinkingNoticeIntervalMs:
            this.options.config.wechat.thinkingNoticeMs,
          shouldSendThinkingNotice: () => true,
          buildThinkingNoticeText: (elapsedSeconds) =>
            buildThinkingNoticeText({
              role: route.role,
              elapsedSeconds,
            }),
          work: () =>
            buildCodexReply({
              backend: backendForTurn.backend,
              backendKind: backendForTurn.backendKind,
              config: this.options.config,
              database: this.options.database,
              role: route.role,
              session: sessionForReply,
              userText: codexUserText,
              attachments: pendingAttachments,
              persistentContext: backendForTurn.persistentSession,
              includeRecentTurns:
                !(
                  route.role === "family" &&
                  backendForTurn.backendKind === "acp"
                ),
              responseMode:
                route.role === "family" &&
                backendForTurn.backendKind === "acp"
                  ? "final_message_run"
                  : "full_text",
              onProgress: (event) => {
                progress.phase = event.phase;
              },
            }),
        });
        rawReply = await handleAssistantFileActions({
          rawReply,
          config: this.options.config,
          client,
          database: this.options.database,
          session: sessionForReply,
          role: route.role,
        });
        } catch (error) {
          console.error("[worker] codex reply failed", error);
          rawReply = buildCodexErrorReply({
            error,
            role: route.role,
            accountRole: accountRoute.role,
            sessionMode: sessionMemory.routeMode,
            codexCommand: this.options.config.codex[route.role].command,
          });
        }
      }

    const replyText =
      route.role === "family"
        ? filterFamilyOutput(rawReply, this.options.config.familyPolicy)
        : rawReply;
    const finalReplyText = [dayChangeNotice, replyText].filter(Boolean).join("\n");

    if (!finalReplyText.trim()) {
      return;
    }

    let lastClientId = "";
    const chunks = splitReplyText(
      finalReplyText,
      this.options.config.wechat.replyChunkChars,
    );
    for (const [index, chunk] of chunks.entries()) {
      lastClientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: chunk,
      });
      if (index < chunks.length - 1) {
        await sleep(350);
      }
    }

    this.options.database.appendMessage({
      id: buildMessageId("outbound"),
      sessionId: sessionForReply.id,
      direction: "outbound",
      messageType: "text",
      textContent: finalReplyText,
      createdAt: new Date().toISOString(),
      sourceMessageId: lastClientId || inbound.sourceMessageId,
    });
    const latestMemory = parseSessionMemory(sessionForReply.memoryJson);
    this.options.database.saveSession({
      id: sessionForReply.id,
      wechatAccountId: sessionForReply.wechatAccountId,
      contactId: sessionForReply.contactId,
      role: route.role,
      status: sessionForReply.status,
      summaryText: sessionForReply.summaryText,
      memoryJson: stringifySessionMemory({
        ...latestMemory,
        turnCount:
          Math.max(latestMemory.turnCount ?? 0, sessionMemory.turnCount ?? 0) + 1,
        estimatedTokenCount:
          Math.max(
            latestMemory.estimatedTokenCount ?? 0,
            sessionMemory.estimatedTokenCount ?? 0,
          ) +
          estimateTextTokens(userTextForCodex) +
          estimateTextTokens(finalReplyText),
      }),
      contextToken: sessionForReply.contextToken,
      lastActiveAt: new Date().toISOString(),
    });
  }
}
