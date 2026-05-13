import { AppDatabase, MessageRecord, SessionRecord } from "../../storage/index.js";
import { parseSessionMemory } from "../../sessions/index.js";

const FAMILY_API_CONTEXT_CHAR_BUDGET = 16_000;
const FAMILY_API_CONTEXT_ENTRY_CHAR_BUDGET = 3_000;
const FAMILY_ACP_NOTE_CHAR_BUDGET = 1_500;
const FAMILY_SHORT_TAIL_MESSAGE_LIMIT = 6;
const FAMILY_SHORT_TAIL_CHAR_BUDGET = 3_000;

function normalizeText(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

function isCurrentUserEcho(message: MessageRecord, currentUserText: string): boolean {
  return (
    message.direction === "inbound" &&
    normalizeText(message.textContent ?? "") === currentUserText
  );
}

function selectRecentMessages(params: {
  database: AppDatabase;
  session: SessionRecord;
  currentUserText: string;
  maxMessages: number;
  maxChars: number;
}): MessageRecord[] {
  const normalizedCurrentUserText = normalizeText(params.currentUserText);
  const newestFirst = params.database
    .listSessionMessages(params.session.id, params.maxMessages)
    .filter((message) => message.textContent?.trim())
    .filter(
      (message) => !isCurrentUserEcho(message, normalizedCurrentUserText),
    );

  const selected: MessageRecord[] = [];
  let usedChars = 0;
  for (const message of newestFirst) {
    const text = normalizeText(message.textContent ?? "");
    if (!text) {
      continue;
    }

    const nextChars = usedChars + text.length;
    if (selected.length > 0 && nextChars > params.maxChars) {
      break;
    }

    selected.push(message);
    usedChars = nextChars;
  }

  return selected.reverse();
}

function trimToBudget(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trim()}\n[truncated]`;
}

export function buildFamilyApiContextBlock(params: {
  session: SessionRecord;
}): string | undefined {
  const memory = parseSessionMemory(params.session.memoryJson);
  const sections: string[] = [];

  if (memory.familyApiContext?.trim()) {
    sections.push(`Conversation so far:\n${memory.familyApiContext.trim()}`);
  } else if (memory.carryoverSummary?.trim() || params.session.summaryText.trim()) {
    sections.push(
      `Session carryover:\n${memory.carryoverSummary?.trim() || params.session.summaryText.trim()}`,
    );
  }

  if (memory.lastAcpTaskNote?.trim()) {
    sections.push(`Recent file/tool task note:\n${memory.lastAcpTaskNote.trim()}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function appendFamilyApiContext(params: {
  existingContext?: string | undefined;
  userText: string;
  assistantText: string;
}): string {
  const entries = [
    params.existingContext?.trim() ?? "",
    `User: ${trimToBudget(params.userText, FAMILY_API_CONTEXT_ENTRY_CHAR_BUDGET)}`,
    `Assistant: ${trimToBudget(params.assistantText, FAMILY_API_CONTEXT_ENTRY_CHAR_BUDGET)}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (entries.length <= FAMILY_API_CONTEXT_CHAR_BUDGET) {
    return entries;
  }

  return entries.slice(entries.length - FAMILY_API_CONTEXT_CHAR_BUDGET).trimStart();
}

export function buildAcpTaskNote(params: {
  attachments: Array<{ fileName: string }>;
  finalText: string;
}): string | undefined {
  const finalText = trimToBudget(params.finalText, FAMILY_ACP_NOTE_CHAR_BUDGET);
  if (!finalText) {
    return undefined;
  }

  const attachmentNames = params.attachments
    .map((attachment) => attachment.fileName.trim())
    .filter(Boolean)
    .slice(0, 5);
  return [
    attachmentNames.length > 0
      ? `Files: ${attachmentNames.join(", ")}`
      : "",
    `Result: ${finalText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFamilyConversationContext(params: {
  database: AppDatabase;
  session: SessionRecord;
  currentUserText: string;
}): string | undefined {
  const memory = parseSessionMemory(params.session.memoryJson);
  const sections: string[] = [];
  const carryover = memory.carryoverSummary?.trim() || params.session.summaryText.trim();
  if (carryover) {
    sections.push(`Session carryover:\n${carryover}`);
  }

  const recent = selectRecentMessages({
    database: params.database,
    session: params.session,
    currentUserText: params.currentUserText,
    maxMessages: FAMILY_SHORT_TAIL_MESSAGE_LIMIT,
    maxChars: FAMILY_SHORT_TAIL_CHAR_BUDGET,
  }).map((message) => {
    const speaker = message.direction === "inbound" ? "User" : "Assistant";
    return `${speaker}: ${normalizeText(message.textContent ?? "")}`;
  });

  if (recent.length > 0) {
    sections.push(`Recent conversation tail:\n${recent.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}
