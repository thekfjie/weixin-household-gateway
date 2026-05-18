import { AppConfig, UserRole } from "../../config/index.js";
import { CodexProgressEvent } from "../../codex/index.js";
import { filterFamilyOutput } from "../../policy/index.js";
import { ILinkApiClient } from "./api-client.js";
import { sendTextMessage } from "./media.js";

export const FINAL_REPLY_MESSAGE_SLOTS = 1;

export interface TurnMessageBudget {
  preFinalMessageBudget: number;
  progressMessageBudget: number;
  familyApiEarlyMessageBudget: number;
  tryReservePreFinalMessage(): boolean;
}

export interface StreamingReplySender {
  handleDelta(delta: string): void;
  flush(): Promise<void>;
  hasSentText(): boolean;
  removeAlreadySentText(text: string): string;
}

export interface ProgressReplySender {
  handle(event: CodexProgressEvent): void;
  flush(): Promise<void>;
  removeAlreadySentText(text: string): string;
}

export function createTurnMessageBudget(params: {
  turnMessageLimit: number;
  role: UserRole;
}): TurnMessageBudget {
  const preFinalMessageBudget = Math.max(
    0,
    params.turnMessageLimit - FINAL_REPLY_MESSAGE_SLOTS,
  );
  let reservedPreFinalMessages = 0;

  return {
    preFinalMessageBudget,
    progressMessageBudget:
      params.role === "admin"
        ? preFinalMessageBudget
        : Math.min(4, preFinalMessageBudget),
    familyApiEarlyMessageBudget: Math.min(2, preFinalMessageBudget),
    tryReservePreFinalMessage() {
      if (reservedPreFinalMessages >= preFinalMessageBudget) {
        return false;
      }

      reservedPreFinalMessages += 1;
      return true;
    },
  };
}

export function shouldSendProgressByTimeline(params: {
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

export function buildThinkingNoticeScheduleMs(params: {
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

export function compactFinalReplyChunks(
  chunks: string[],
  maxChunks: number,
): string[] {
  const chunkLimit = Math.max(1, maxChunks);
  if (chunks.length <= chunkLimit) {
    return chunks;
  }

  return [
    ...chunks.slice(0, chunkLimit - 1),
    chunks.slice(chunkLimit - 1).join("\n\n"),
  ].filter(Boolean);
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

export function createProgressReplySender(params: {
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

export function createFamilyApiStreamingSender(params: {
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
