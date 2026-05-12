import { AppConfig, UserRole } from "../config/types.js";
import {
  buildPromptContext,
  buildSessionWorkspacePaths,
  parseSessionMemory,
} from "../sessions/index.js";
import { AppDatabase, SessionRecord } from "../storage/index.js";

function buildSummary(params: {
  role: UserRole;
  session: SessionRecord;
}): string | undefined {
  if (params.role === "admin") {
    return undefined;
  }

  const memory = parseSessionMemory(params.session.memoryJson);
  const primary = memory.carryoverSummary?.trim() || params.session.summaryText.trim();
  return primary || undefined;
}

function buildRecentTurns(params: {
  database: AppDatabase;
  session: SessionRecord;
}): string {
  const recentMessages = params.database
    .listSessionMessages(params.session.id, 8)
    .reverse()
    .filter((message) => message.textContent?.trim())
    .map((message) => {
      const speaker = message.direction === "inbound" ? "User" : "Assistant";
      return `${speaker}: ${message.textContent?.trim() ?? ""}`;
    });

  return recentMessages.join("\n");
}

function buildSystemPrompt(params: {
  role: UserRole;
  summary?: string;
}): string {
  const promptContext = buildPromptContext({
    role: params.role,
    ...(params.summary
      ? {
          summary: {
            summary: params.summary,
            facts: [],
            openLoops: [],
            lastActiveAt: "",
          },
        }
      : {}),
  });

  return [
    promptContext.assistantInstruction,
    promptContext.summaryText ? `Conversation summary:\n${promptContext.summaryText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUserPrompt(params: {
  database: AppDatabase;
  session: SessionRecord;
  userText: string;
  includeRecentTurns: boolean;
}): string {
  const sections: string[] = [];

  if (params.includeRecentTurns) {
    const recentTurns = buildRecentTurns({
      database: params.database,
      session: params.session,
    });
    if (recentTurns) {
      sections.push(recentTurns);
    }
  }

  sections.push(`User: ${params.userText.trim()}`);
  return sections.join("\n");
}

function buildAdditionalDirectories(params: {
  config: AppConfig;
  role: UserRole;
  session: SessionRecord;
}): {
  additionalDirectories: string[];
  readOnlyDirectories: string[];
} {
  const workspacePaths = buildSessionWorkspacePaths({
    config: params.config,
    sessionId: params.session.id,
  });

  if (params.role === "admin") {
    return {
      additionalDirectories: Object.values(workspacePaths),
      readOnlyDirectories: [],
    };
  }

  return {
    additionalDirectories: Object.values(workspacePaths),
    readOnlyDirectories: [workspacePaths.inboxDir],
  };
}

export function buildCodexPromptSet(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  userText: string;
  persistentContext: boolean;
}): {
  prompt: string;
  bootstrapPrompt?: string;
  systemPrompt?: string;
  additionalDirectories: string[];
  readOnlyDirectories: string[];
} {
  const summary = buildSummary({
    role: params.role,
    session: params.session,
  });
  const systemPrompt = buildSystemPrompt({
    role: params.role,
    ...(summary ? { summary } : {}),
  });
  const prompt = buildUserPrompt({
    database: params.database,
    session: params.session,
    userText: params.userText,
    includeRecentTurns: !params.persistentContext,
  });
  const bootstrapPrompt = params.persistentContext
    ? buildUserPrompt({
        database: params.database,
        session: params.session,
        userText: params.userText,
        includeRecentTurns: true,
      })
    : undefined;
  const directories = buildAdditionalDirectories({
    config: params.config,
    role: params.role,
    session: params.session,
  });

  return {
    prompt,
    ...(bootstrapPrompt ? { bootstrapPrompt } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    additionalDirectories: directories.additionalDirectories,
    readOnlyDirectories: directories.readOnlyDirectories,
  };
}
