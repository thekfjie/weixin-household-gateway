import fs from "node:fs";
import { CodexRuntimeConfig } from "../config/types.js";
import {
  CodexBackend,
  CodexBackendRequest,
  CodexInputPart,
} from "./backend-types.js";
import { CodexRunResult } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
  output_text?: string;
  error?: {
    message?: string;
  };
}

interface ChatCompletionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface ChatCompletionMessage {
  role: "system" | "user";
  content: string | ChatCompletionContentPart[];
}

function buildUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }

  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function readContent(payload: ChatCompletionResponse): string {
  return (
    payload.output_text ??
    payload.choices?.[0]?.message?.content ??
    payload.choices?.[0]?.text ??
    ""
  );
}

function buildPromptCacheKey(
  prefix: string,
  request: CodexBackendRequest,
): string {
  return request.promptCacheKey || `${prefix}:${request.role}:${request.conversationId}`;
}

function toDataUrl(filePath: string, mimeType: string): string {
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildUserContent(
  parts: CodexInputPart[] | undefined,
  fallbackPrompt: string,
): string | ChatCompletionContentPart[] {
  if (!parts || parts.length === 0) {
    return fallbackPrompt;
  }

  return parts.map<ChatCompletionContentPart>((part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
      };
    }

    return {
      type: "image_url",
      image_url: {
        url: toDataUrl(part.filePath, part.mimeType),
      },
    };
  });
}

function buildMessages(request: CodexBackendRequest): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];

  if (request.systemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: request.systemPrompt.trim(),
    });
  }

  messages.push({
    role: "user",
    content: buildUserContent(request.inputParts, request.prompt),
  });

  return messages;
}

export class ApiCodexBackend implements CodexBackend {
  constructor(private readonly config: CodexRuntimeConfig) {}

  async run(request: CodexBackendRequest): Promise<CodexRunResult> {
    if (!this.config.apiBaseUrl || !this.config.apiKey) {
      return {
        text: "",
        stderr: "API backend missing CODEX_API_BASE_URL or CODEX_API_KEY",
        exitCode: 1,
        timedOut: false,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(buildUrl(this.config.apiBaseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.apiModel,
          prompt_cache_key: buildPromptCacheKey(
            this.config.apiPromptCacheKeyPrefix,
            request,
          ),
          messages: buildMessages(request),
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: ChatCompletionResponse;
      try {
        payload = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        return {
          text: "",
          stderr: `API backend returned non-JSON: ${text.slice(0, 500)}`,
          exitCode: 1,
          timedOut: false,
        };
      }

      if (!response.ok) {
        return {
          text: "",
          stderr:
            payload.error?.message ??
            `API backend HTTP ${response.status}: ${text.slice(0, 500)}`,
          exitCode: 1,
          timedOut: false,
        };
      }

      const content = readContent(payload).trim();
      if (!content) {
        return {
          text: "",
          stderr: "API backend returned empty content",
          exitCode: 1,
          timedOut: false,
        };
      }

      return {
        text: content,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    } catch (error) {
      const timedOut =
        error instanceof Error && error.name === "AbortError";
      return {
        text: "",
        stderr: timedOut
          ? `API backend timed out after ${this.config.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
        exitCode: 1,
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  clearSession(_conversationId: string): void {}

  dispose(): void {}
}
