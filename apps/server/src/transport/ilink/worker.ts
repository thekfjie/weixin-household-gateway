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
import type { ParsedCommand } from "../../commands/index.js";
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
  splitReplyTextBySystemNotice,
  buildCodexErrorReply,
  buildCommandErrorReply,
  buildThinkingNoticeText,
} from "./reply.js";
import { withTypingIndicator } from "./typing.js";
import { handleAssistantFileActions, handleFileCommand } from "./file-command.js";
import { sleep } from "../../utils/index.js";
import { decideFamilyBackend } from "./routing.js";
import { buildApiInputParts } from "./api-input.js";
import {
  appendFamilyApiContext,
  buildAcpTaskNote,
  buildFamilyConversationContext,
} from "./conversation-context.js";

function buildMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const FINAL_REPLY_MESSAGE_SLOTS = 1;

interface ActiveTurn {
  controller: AbortController;
  conversationId: string;
  backend?: CodexBackend | undefined;
  startedAt: string;
}

function isStopCommand(command: ParsedCommand | undefined): boolean {
  return command?.name === "/stop" || command?.name === "/cancel";
}

function shouldSendProgressByTimeline(params: {
  queuedCount: number;
  elapsedMs: number;
  timeoutMs: number;
  maxMessages: number;
}): boolean {
  if (params.queuedCount >= params.maxMessages) {
    return false;
  }

  const timeoutMs = Math.max(params.timeoutMs, 60_000);
  const edgeWindowMs = Math.min(120_000, Math.max(45_000, timeoutMs * 0.2));
  const lateStartMs = Math.max(edgeWindowMs, timeoutMs - edgeWindowMs);
  const earlyLimit = Math.min(4, params.maxMessages);
  const lateReserve = params.maxMessages >= 4 ? 2 : 1;
  const middleLimit = Math.max(
    earlyLimit,
    params.maxMessages - lateReserve,
  );

  if (params.elapsedMs <= edgeWindowMs) {
    return params.queuedCount < earlyLimit;
  }

  if (params.elapsedMs >= lateStartMs) {
    return true;
  }

  return params.queuedCount < middleLimit;
}

function buildThinkingNoticeScheduleMs(params: {
  intervalMs: number;
  timeoutMs: number;
  maxMessages: number;
  streamingEnabled?: boolean | undefined;
}): number[] {
  if (params.intervalMs <= 0 || params.maxMessages <= 0) {
    return [];
  }

  const timeoutMs = Math.max(params.timeoutMs, params.intervalMs);
  const latestMs = Math.max(params.intervalMs, timeoutMs - 5_000);
  const candidates = [
    params.intervalMs,
    ...(params.streamingEnabled
      ? [timeoutMs - 30_000]
      : [
          Math.round(timeoutMs * 0.25),
          Math.round(timeoutMs * 0.65),
          timeoutMs - 120_000,
          timeoutMs - 30_000,
        ]),
  ];
  const unique = new Set<number>();
  for (const candidate of candidates) {
    const offset = Math.round(candidate);
    if (offset >= params.intervalMs && offset <= latestMs) {
      unique.add(offset);
    }
  }

  return [...unique]
    .sort((left, right) => left - right)
    .slice(0, params.maxMessages);
}

function compactFinalReplyChunks(chunks: string[], maxChunks: number): string[] {
  const chunkLimit = Math.max(1, maxChunks);
  if (chunks.length <= chunkLimit) {
    return chunks;
  }

  return [
    ...chunks.slice(0, chunkLimit - 1),
    chunks.slice(chunkLimit - 1).join("\n\n"),
  ].filter(Boolean);
}

function resolveOutputProgressEnabled(params: {
  config: AppConfig;
  role: UserRole;
  sessionMemory: ReturnType<typeof parseSessionMemory>;
}): boolean {
  return (
    params.sessionMemory.outputProgressEnabled ??
    (params.role === "admin"
      ? params.config.wechat.adminProgressEnabled
      : params.config.wechat.familyProgressEnabled)
  );
}

function resolveFamilyApiStreamingEnabled(params: {
  config: AppConfig;
  sessionMemory: ReturnType<typeof parseSessionMemory>;
}): boolean {
  return (
    params.sessionMemory.familyApiStreamingEnabled ??
    params.config.wechat.familyApiStreamingEnabled
  );
}

interface StreamingReplySender {
  handleDelta(delta: string): void;
  flush(): Promise<void>;
  hasSentText(): boolean;
  removeAlreadySentText(text: string): string;
}

interface ProgressReplySender {
  handle(event: CodexProgressEvent): void;
  flush(): Promise<void>;
  removeAlreadySentText(text: string): string;
}

function normalizeForDuplicateCheck(text: string): string {
  return text.replace(/\s+/g, "").trim();
}

function isDuplicateOrContainedText(text: string, previousTexts: string[]): boolean {
  const normalizedText = normalizeForDuplicateCheck(text);
  if (!normalizedText) {
    return true;
  }

  return previousTexts.some((previousText) => {
    const normalizedPrevious = normalizeForDuplicateCheck(previousText);
    return (
      normalizedPrevious === normalizedText ||
      normalizedPrevious.includes(normalizedText) ||
      normalizedText.includes(normalizedPrevious)
    );
  });
}

function createProgressReplySender(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  includeToolProgress: boolean;
  maxProgressMessages: number;
  minIntervalMs: number;
  shouldSend?: () => boolean;
  shouldSendAt?: (params: { queuedCount: number; now: number }) => boolean;
  filterText?: (text: string) => string;
}): ProgressReplySender {
  let queue = Promise.resolve();
  let lastSentAt = 0;
  let queuedCount = 0;
  const sentTexts: string[] = [];
  const queuedTexts: string[] = [];
  const maxProgressMessages = params.maxProgressMessages;
  const minIntervalMs = params.minIntervalMs;

  const enqueue = (message: string): void => {
    const text = (params.filterText?.(message) ?? message).trim();
    if (
      !text ||
      queuedCount >= maxProgressMessages ||
      isDuplicateOrContainedText(text, queuedTexts) ||
      (params.shouldSendAt &&
        !params.shouldSendAt({ queuedCount, now: Date.now() }))
    ) {
      return;
    }

    const now = Date.now();
    if (queuedCount > 0 && now - lastSentAt < minIntervalMs) {
      return;
    }
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }

    lastSentAt = now;
    queuedCount += 1;
    queuedTexts.push(text);
    queue = queue
      .then(() =>
        sendTextMessage({
          client: params.client,
          toUserId: params.toUserId,
          contextToken: params.contextToken,
          text,
        }),
      )
      .then(() => {
        sentTexts.push(text);
      })
      .catch((error) => {
        console.warn("[worker] failed to send progress reply", error);
      });
  };

  return {
    handle(event) {
      if (event.phase === "responding") {
        return;
      }

      if (event.phase === "visible_message_run" && event.message) {
        enqueue(event.message);
        return;
      }

      if (
        params.includeToolProgress &&
        event.phase === "tool_progress" &&
        event.message
      ) {
        enqueue(event.message);
      }
    },
    flush() {
      return queue;
    },
    removeAlreadySentText(text) {
      let next = text.trim();
      for (const sentText of sentTexts) {
        if (next === sentText) {
          return "";
        }

        if (next.startsWith(sentText)) {
          next = next.slice(sentText.length).trim();
        }
      }
      return next;
    },
  };
}

function createFamilyApiStreamingSender(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  config: AppConfig;
  maxEarlyMessages: number;
  shouldSend?: () => boolean;
}): StreamingReplySender {
  let queue = Promise.resolve();
  let buffer = "";
  let lastSentAt = 0;
  let queuedCount = 0;
  let sawInternalAction = false;
  const sentTexts: string[] = [];
  const queuedTexts: string[] = [];
  const maxEarlyMessages = params.maxEarlyMessages;
  const minFlushChars = 60;
  const minIntervalMs = 2_500;
  const sentenceEndPattern = /[。！？!?]\s*$/;
  const listItemPattern = /^\s*(?:[-*+•]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s+/;

  const send = (text: string): void => {
    if (sawInternalAction || text.includes("[[")) {
      sawInternalAction = true;
      return;
    }

    const cleanText = filterFamilyOutput(text, params.config.familyPolicy);
    if (
      !cleanText ||
      queuedCount >= maxEarlyMessages ||
      isDuplicateOrContainedText(cleanText, queuedTexts)
    ) {
      return;
    }
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }

    queuedCount += 1;
    queuedTexts.push(cleanText);
    queue = queue
      .then(() =>
        sendTextMessage({
          client: params.client,
          toUserId: params.toUserId,
          contextToken: params.contextToken,
          text: cleanText,
        }),
      )
      .then(() => {
        sentTexts.push(cleanText);
      })
      .catch((error) => {
        console.warn("[worker] failed to send family API stream chunk", error);
      });
  };

  const findCutIndex = (text: string): number => {
    const trimmed = text.trimEnd();
    if (trimmed.length < minFlushChars) {
      return 0;
    }

    const paragraphIndex = trimmed.lastIndexOf("\n\n");
    if (paragraphIndex >= minFlushChars) {
      return paragraphIndex + 2;
    }

    const lineIndex = trimmed.lastIndexOf("\n");
    if (lineIndex >= minFlushChars) {
      const beforeLine = trimmed.slice(0, lineIndex).split("\n").pop() ?? "";
      if (listItemPattern.test(beforeLine) || sentenceEndPattern.test(beforeLine)) {
        return lineIndex + 1;
      }
    }

    const sentenceMatch = /[。！？!?](?=\s*$)/.exec(trimmed);
    return sentenceMatch && sentenceMatch.index + 1 >= minFlushChars
      ? sentenceMatch.index + 1
      : 0;
  };

  const maybeFlush = (force = false): void => {
    if (!buffer.trim() || queuedCount >= maxEarlyMessages) {
      return;
    }

    const now = Date.now();
    const enoughTime = lastSentAt === 0 || now - lastSentAt >= minIntervalMs;
    const enoughText = buffer.trim().length >= minFlushChars;
    if (!force && (!enoughTime || !enoughText)) {
      return;
    }

    const cutIndex = force ? buffer.length : findCutIndex(buffer);
    if (cutIndex <= 0) {
      return;
    }

    const chunk = buffer.slice(0, cutIndex).trim();
    buffer = buffer.slice(cutIndex).trimStart();
    lastSentAt = now;
    send(chunk);
  };

  return {
    handleDelta(delta) {
      if (delta.includes("[[")) {
        sawInternalAction = true;
      }
      buffer += delta;
      maybeFlush(false);
    },
    async flush() {
      if (queuedCount > 0) {
        maybeFlush(true);
      }
      await queue;
    },
    hasSentText() {
      return queuedCount > 0;
    },
    removeAlreadySentText(text) {
      let next = text.trim();
      for (const sentText of sentTexts) {
        if (next === sentText) {
          return "";
        }

        if (next.startsWith(sentText)) {
          next = next.slice(sentText.length).trim();
        }
      }

      return next;
    },
  };
}

function buildFamilyAcpHandoff(params: {
  session: SessionRecord;
  database: AppDatabase;
  userText: string;
  attachments: PendingInboundAttachment[];
}): string {
  const conversationContext = buildFamilyConversationContext({
    database: params.database,
    session: params.session,
    currentUserText: params.userText,
  });
  const attachmentSummary = buildAttachmentPromptBlock(params.attachments);
  return [
    conversationContext,
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
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal | undefined;
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
            buildApiSystemPrompt({
              config: params.config,
              role: params.role,
            }),
          inputParts: buildApiInputParts({
            session: params.session,
            userText: params.userText,
            attachments: params.attachments,
          }),
          promptCacheKey: `wechat:${params.role}:${params.session.wechatAccountId}:${params.session.contactId}`,
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
    ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (result.cancelled) {
    if (result.text.trim()) {
      return [
        result.text.trim(),
        "这轮任务已停止。上面是停止前已经生成的内容，可能不是完整最终结果。",
      ].join("\n");
    }

    return "这轮任务已停止。";
  }

  if (result.timedOut) {
    if (result.text.trim()) {
      return [
        result.text.trim(),
        "这轮处理已经超过等待时间，我已停止继续等待。上面是已生成内容，可能不是完整最终结果。",
      ].join("\n");
    }

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

  private readonly activeTurns = new Map<string, ActiveTurn>();

  private readonly inboundTasks = new Set<Promise<void>>();

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
    for (const activeTurn of this.activeTurns.values()) {
      activeTurn.controller.abort();
      await activeTurn.backend?.cancel(activeTurn.conversationId);
    }
    await Promise.allSettled([...this.inboundTasks]);
    this.codexBackends.admin.dispose();
    this.codexBackends["family-acp"].dispose();
    this.codexBackends["family-api"].dispose();
  }

  private getActiveTurnKey(params: {
    wechatAccountId: string;
    contactId: string;
  }): string {
    return `${params.wechatAccountId}\0${params.contactId}`;
  }

  private dispatchInboundMessage(
    account: WechatAccountRecord,
    client: ILinkApiClient,
    inbound: ReturnType<typeof normalizeInboundWechatMessages>[number],
  ): void {
    const task = this.handleInboundMessage(account, client, inbound).catch(
      (error) => {
        console.error("[worker] inbound message task failed", error);
      },
    );
    this.inboundTasks.add(task);
    task.finally(() => {
      this.inboundTasks.delete(task);
    }).catch(() => undefined);
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
      this.dispatchInboundMessage(account, client, inbound);
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
    const parsedControlCommand = parseBuiltInCommand(inbound.text);
    const activeTurnKey = this.getActiveTurnKey({
      wechatAccountId: inbound.wechatAccountId,
      contactId: inbound.contactId,
    });
    const existingActiveTurn = this.activeTurns.get(activeTurnKey);
    if (isStopCommand(parsedControlCommand)) {
      this.options.database.appendMessage({
        id: buildMessageId("inbound"),
        sessionId: activeSession.id,
        direction: "inbound",
        messageType: "text",
        textContent: inbound.text,
        createdAt: inbound.receivedAt,
        sourceMessageId: inbound.sourceMessageId,
      });

      const reply = existingActiveTurn
        ? "已收到停止请求，正在停止当前任务。"
        : "当前没有正在处理的任务。";
      if (existingActiveTurn) {
        existingActiveTurn.controller.abort();
        await existingActiveTurn.backend?.cancel(existingActiveTurn.conversationId);
      }
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: reply,
      });
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: reply,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
      return;
    }

    if (existingActiveTurn) {
      this.options.database.appendMessage({
        id: buildMessageId("inbound"),
        sessionId: activeSession.id,
        direction: "inbound",
        messageType: "text",
        textContent: [inbound.mediaSummary, inbound.text].filter(Boolean).join("\n"),
        createdAt: inbound.receivedAt,
        sourceMessageId: inbound.sourceMessageId,
      });
      const reply = "上一轮还在处理。需要中止的话请发送 /stop。";
      const clientId = await sendTextMessage({
        client,
        toUserId: inbound.contactId,
        contextToken: inbound.contextToken,
        text: reply,
      });
      this.options.database.appendMessage({
        id: buildMessageId("outbound"),
        sessionId: activeSession.id,
        direction: "outbound",
        messageType: "text",
        textContent: reply,
        createdAt: new Date().toISOString(),
        sourceMessageId: clientId || inbound.sourceMessageId,
      });
      return;
    }

    const parsedCommand =
      parsedControlCommand ??
      parseNaturalFileRequest(inbound.text);
    const turnController =
      !parsedCommand && (inbound.text.trim() || inbound.attachments.length > 0)
        ? new AbortController()
        : undefined;
    if (turnController) {
      this.activeTurns.set(activeTurnKey, {
        controller: turnController,
        conversationId: activeSession.id,
        startedAt: new Date().toISOString(),
      });
    }

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
    let downloadedAttachments: PendingInboundAttachment[];
    try {
      downloadedAttachments =
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
    } catch (error) {
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
      throw error;
    }

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
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
      return;
    }

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
    let progressReplySender: ProgressReplySender | undefined;
    let streamingReplySender: StreamingReplySender | undefined;
    let backendForCompletedTurn:
      | {
          backendKind: CodexRuntimeConfig["backend"];
          persistentSession: boolean;
        }
      | undefined;
    let familyBackendReason: ReturnType<typeof decideFamilyBackend>["reason"] | undefined;
    let codexTurnSucceeded = false;

    if (parsedCommand) {
      const activeTurn = this.activeTurns.get(activeTurnKey);
      if (activeTurn?.controller === turnController) {
        this.activeTurns.delete(activeTurnKey);
      }
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
        if (turnController) {
          const activeTurn = this.activeTurns.get(activeTurnKey);
          if (activeTurn?.controller === turnController) {
            activeTurn.conversationId = sessionForReply.id;
            activeTurn.backend = backendForTurn.backend;
          } else {
            this.activeTurns.set(activeTurnKey, {
              controller: turnController,
              conversationId: sessionForReply.id,
              backend: backendForTurn.backend,
              startedAt: new Date().toISOString(),
            });
          }
        }
        backendForCompletedTurn = {
          backendKind: backendForTurn.backendKind,
          persistentSession: backendForTurn.persistentSession,
        };
        familyBackendReason =
          route.role === "family"
            ? decideFamilyBackend({
                userText: inbound.text,
                attachments: pendingAttachments,
              }).reason
            : undefined;
        const outputProgressEnabled = resolveOutputProgressEnabled({
          config: this.options.config,
          role: route.role,
          sessionMemory,
        });
        const familyApiStreamingEnabled = resolveFamilyApiStreamingEnabled({
          config: this.options.config,
          sessionMemory,
        });
        const turnStartedAt = Date.now();
        const preFinalMessageBudget = Math.max(
          0,
          this.options.config.wechat.turnMessageLimit - FINAL_REPLY_MESSAGE_SLOTS,
        );
        let reservedPreFinalMessages = 0;
        const tryReservePreFinalMessage = (): boolean => {
          if (reservedPreFinalMessages >= preFinalMessageBudget) {
            return false;
          }

          reservedPreFinalMessages += 1;
          return true;
        };
        const progressMessageBudget =
          route.role === "admin"
            ? preFinalMessageBudget
            : Math.min(4, preFinalMessageBudget);
        const familyApiEarlyMessageBudget = Math.min(
          2,
          preFinalMessageBudget,
        );
        progressReplySender =
          outputProgressEnabled && backendForTurn.backendKind === "acp"
            ? createProgressReplySender({
                client,
                toUserId: inbound.contactId,
                contextToken: inbound.contextToken,
                includeToolProgress: route.role === "admin",
                maxProgressMessages: progressMessageBudget,
                minIntervalMs: route.role === "admin" ? 15_000 : 8_000,
                shouldSend: tryReservePreFinalMessage,
                shouldSendAt: ({ queuedCount, now }) =>
                  shouldSendProgressByTimeline({
                    queuedCount,
                    elapsedMs: now - turnStartedAt,
                    timeoutMs: this.options.config.codex[route.role].timeoutMs,
                    maxMessages: progressMessageBudget,
                  }),
                ...(route.role === "family"
                  ? {
                      filterText: (text) =>
                        filterFamilyOutput(text, this.options.config.familyPolicy),
                    }
                  : {}),
              })
            : undefined;
        streamingReplySender =
          route.role === "family" &&
          backendForTurn.backendKind === "api" &&
          familyApiStreamingEnabled
            ? createFamilyApiStreamingSender({
                client,
                toUserId: inbound.contactId,
                contextToken: inbound.contextToken,
                config: this.options.config,
                maxEarlyMessages: familyApiEarlyMessageBudget,
                shouldSend: tryReservePreFinalMessage,
              })
            : undefined;
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
            progressReplySender
              ? 0
              : this.options.config.wechat.thinkingNoticeMs,
          thinkingNoticeScheduleMs:
            !progressReplySender
              ? buildThinkingNoticeScheduleMs({
                  intervalMs: this.options.config.wechat.thinkingNoticeMs,
                  timeoutMs: this.options.config.codex[route.role].timeoutMs,
                  maxMessages: preFinalMessageBudget,
                  streamingEnabled: Boolean(streamingReplySender),
                })
              : undefined,
          shouldSendThinkingNotice: () =>
            !(streamingReplySender?.hasSentText() ?? false) &&
            tryReservePreFinalMessage(),
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
                backendForTurn.backendKind === "acp"
                  ? "final_message_run"
                  : "full_text",
              onProgress: (event) => {
                progress.phase = event.phase;
                progressReplySender?.handle(event);
              },
              ...(streamingReplySender
                ? {
                    onTextDelta: (delta) => {
                      streamingReplySender?.handleDelta(delta);
                    },
                  }
                : {}),
              ...(turnController ? { signal: turnController.signal } : {}),
            }),
        });
        await progressReplySender?.flush();
        await streamingReplySender?.flush();
        rawReply = await handleAssistantFileActions({
          rawReply,
          config: this.options.config,
          client,
          database: this.options.database,
          session: sessionForReply,
          role: route.role,
        });
        codexTurnSucceeded = true;
      } catch (error) {
        console.error("[worker] codex reply failed", error);
        rawReply = buildCodexErrorReply({
          error,
          role: route.role,
          accountRole: accountRoute.role,
          sessionMode: sessionMemory.routeMode,
          codexCommand: this.options.config.codex[route.role].command,
        });
      } finally {
        const activeTurn = this.activeTurns.get(activeTurnKey);
        if (activeTurn?.controller === turnController) {
          this.activeTurns.delete(activeTurnKey);
        }
      }
    }

    const replyText =
      route.role === "family"
        ? filterFamilyOutput(rawReply, this.options.config.familyPolicy)
        : rawReply;
    const remainingReplyText =
      progressReplySender?.removeAlreadySentText(replyText) ??
      streamingReplySender?.removeAlreadySentText(replyText) ??
      replyText;
    const finalReplyText = [dayChangeNotice, replyText].filter(Boolean).join("\n");

    if (!finalReplyText.trim()) {
      return;
    }

    const textToSend = [dayChangeNotice, remainingReplyText]
      .filter(Boolean)
      .join("\n");
    let lastClientId = "";
    if (textToSend.trim()) {
      const chunks = compactFinalReplyChunks(
        splitReplyTextBySystemNotice(textToSend),
        FINAL_REPLY_MESSAGE_SLOTS,
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
    const latestSession =
      this.options.database.getSessionById(sessionForReply.id) ?? sessionForReply;
    const latestMemory = parseSessionMemory(latestSession.memoryJson);
    const familyApiContext =
      codexTurnSucceeded &&
      route.role === "family" &&
      backendForCompletedTurn?.backendKind === "api"
        ? appendFamilyApiContext({
            existingContext: latestMemory.familyApiContext,
            userText: inbound.text,
            assistantText: replyText,
          })
        : latestMemory.familyApiContext;
    const lastAcpTaskNote =
      codexTurnSucceeded &&
      route.role === "family" &&
      backendForCompletedTurn?.backendKind === "acp"
        ? buildAcpTaskNote({
            attachments: pendingAttachments,
            finalText: replyText,
          })
        : codexTurnSucceeded && backendForCompletedTurn?.backendKind === "api"
          ? undefined
          : latestMemory.lastAcpTaskNote;
    const {
      familyApiContext: _previousFamilyApiContext,
      lastAcpTaskNote: _previousLastAcpTaskNote,
      lastFamilyBackend: _previousLastFamilyBackend,
      lastFamilyBackendReason: _previousLastFamilyBackendReason,
      ...nextMemoryBase
    } = latestMemory;
    this.options.database.saveSession({
      id: sessionForReply.id,
      wechatAccountId: sessionForReply.wechatAccountId,
      contactId: sessionForReply.contactId,
      role: latestSession.role,
      status: latestSession.status,
      summaryText: latestSession.summaryText,
      memoryJson: stringifySessionMemory({
        ...nextMemoryBase,
        ...(familyApiContext ? { familyApiContext } : {}),
        ...(lastAcpTaskNote ? { lastAcpTaskNote } : {}),
        ...(route.role === "family" && backendForCompletedTurn
          ? {
              lastFamilyBackend:
                backendForCompletedTurn.backendKind === "acp" ? "acp" : "api",
            }
          : {}),
        ...(familyBackendReason
          ? { lastFamilyBackendReason: familyBackendReason }
          : {}),
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
      contextToken: latestSession.contextToken,
      lastActiveAt: new Date().toISOString(),
    });
  }
}
