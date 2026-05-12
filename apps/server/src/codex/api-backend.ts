import fs from "node:fs";
import { CodexRuntimeConfig } from "../config/types.js";
import {
  CodexBackend,
  CodexBackendRequest,
  CodexInputPart,
} from "./backend-types.js";
import { CodexRunResult } from "./types.js";

const RESPONSES_UNSUPPORTED_TTL_MS = 30 * 60 * 1000;

interface ApiErrorPayload {
  message?: string;
  type?: string;
  code?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
  output_text?: string;
  error?: ApiErrorPayload;
}

interface ChatCompletionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatCompletionContentPart[];
}

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface ResponsesApiResponse {
  output_text?: string;
  output?: ResponsesOutputItem[];
  error?: ApiErrorPayload;
}

type ResponsesTextPart =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "output_text";
      text: string;
    };

type ResponsesImagePart = {
  type: "input_image";
  image_url: string;
};

interface ResponsesInputMessage {
  role: "user" | "assistant";
  content: Array<ResponsesTextPart | ResponsesImagePart>;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }

  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildResponsesUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/responses")) {
    return baseUrl;
  }

  return `${baseUrl.replace(/\/+$/, "")}/responses`;
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

function readChatCompletionContent(payload: ChatCompletionResponse): string {
  return (
    payload.output_text ??
    payload.choices?.[0]?.message?.content ??
    payload.choices?.[0]?.text ??
    ""
  );
}

function readResponsesContent(payload: ResponsesApiResponse): string {
  if (payload.output_text?.trim()) {
    return payload.output_text.trim();
  }

  const text = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && part.text?.trim())
    .map((part) => part.text?.trim() ?? "")
    .join("\n");

  return text.trim();
}

function buildChatCompletionMessages(
  request: CodexBackendRequest,
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];

  if (request.systemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: request.systemPrompt.trim(),
    });
  }

  const parts = request.inputParts ?? [];
  const structuredMessages = parts.filter(
    (part): part is Extract<CodexInputPart, { type: "message" }> =>
      part.type === "message",
  );
  const textParts = parts.filter(
    (part): part is Extract<CodexInputPart, { type: "text" }> =>
      part.type === "text",
  );
  const imageParts = parts.filter(
    (part): part is Extract<CodexInputPart, { type: "image" }> =>
      part.type === "image",
  );

  for (const part of structuredMessages) {
    messages.push({
      role: part.role,
      content: part.text,
    });
  }

  const currentUserContent: ChatCompletionContentPart[] = [];
  for (const part of textParts) {
    if (!part.text.trim()) {
      continue;
    }
    currentUserContent.push({
      type: "text",
      text: part.text,
    });
  }

  for (const part of imageParts) {
    currentUserContent.push({
      type: "image_url",
      image_url: {
        url: toDataUrl(part.filePath, part.mimeType),
      },
    });
  }

  if (currentUserContent.length > 0) {
    messages.push({
      role: "user",
      content:
        currentUserContent.length === 1 &&
        currentUserContent[0]?.type === "text" &&
        currentUserContent[0].text
          ? currentUserContent[0].text
          : currentUserContent,
    });
  } else if (request.prompt.trim()) {
    messages.push({
      role: "user",
      content: request.prompt.trim(),
    });
  }

  return messages;
}

function buildResponsesInput(
  request: CodexBackendRequest,
): ResponsesInputMessage[] {
  const parts = request.inputParts ?? [];
  const input: ResponsesInputMessage[] = [];
  const currentTurnContent: ResponsesInputMessage["content"] = [];

  const pushTextMessage = (role: "user" | "assistant", text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    input.push({
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: trimmed,
        },
      ],
    });
  };

  for (const part of parts) {
    if (part.type === "message") {
      pushTextMessage(part.role, part.text);
      continue;
    }

    if (part.type === "text") {
      const trimmed = part.text.trim();
      if (!trimmed) {
        continue;
      }
      currentTurnContent.push({
        type: "input_text",
        text: trimmed,
      });
      continue;
    }

    currentTurnContent.push({
      type: "input_image",
      image_url: toDataUrl(part.filePath, part.mimeType),
    });
  }

  if (currentTurnContent.length > 0) {
    input.push({
      role: "user",
      content: currentTurnContent,
    });
  }

  if (input.length === 0 && request.prompt.trim()) {
    pushTextMessage("user", request.prompt);
  }

  return input;
}

function isTemporaryFailure(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isCapabilityUnsupported(
  status: number,
  payload:
    | ChatCompletionResponse
    | ResponsesApiResponse
    | undefined,
  responseText: string,
): boolean {
  if ([404, 405, 501].includes(status)) {
    return true;
  }

  const message = [
    payload?.error?.message,
    payload?.error?.type,
    payload?.error?.code,
    responseText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const unsupportedSignal =
    /(unsupported|not supported|unknown|invalid|unrecognized|unexpected|not found|disabled|extra fields? not permitted)/.test(
      message,
    );
  const responsesSpecificSignal =
    /(^|[\s"'`/])(responses?|response\.create|instructions|input|input_text|input_image|output_text)([\s"'`:/]|$)/.test(
      message,
    );
  const assistantRoleUnsupportedSignal =
    /assistant/.test(message) &&
    /(role|input|output_text)/.test(message) &&
    unsupportedSignal;

  return (
    (responsesSpecificSignal && unsupportedSignal) ||
    assistantRoleUnsupportedSignal
  );
}

async function parseJsonResponse<T>(
  response: Response,
): Promise<{ text: string; payload?: T }> {
  const text = await response.text();
  try {
    return {
      text,
      payload: JSON.parse(text) as T,
    };
  } catch {
    return { text };
  }
}

export class ApiCodexBackend implements CodexBackend {
  private responsesUnsupportedUntil = 0;

  constructor(private readonly config: CodexRuntimeConfig) {}

  private shouldTryResponses(): boolean {
    return Date.now() >= this.responsesUnsupportedUntil;
  }

  private markResponsesUnsupported(): void {
    this.responsesUnsupportedUntil = Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
  }

  private clearResponsesUnsupported(): void {
    this.responsesUnsupportedUntil = 0;
  }

  private async runResponses(
    request: CodexBackendRequest,
    controller: AbortController,
  ): Promise<
    | { kind: "success"; result: CodexRunResult }
    | { kind: "fallback" }
    | { kind: "error"; result: CodexRunResult }
  > {
    const response = await fetch(buildResponsesUrl(this.config.apiBaseUrl!), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.apiModel,
        instructions: request.systemPrompt?.trim() || undefined,
        prompt_cache_key: buildPromptCacheKey(
          this.config.apiPromptCacheKeyPrefix,
          request,
        ),
        input: buildResponsesInput(request),
      }),
      signal: controller.signal,
    });

    const { text, payload } = await parseJsonResponse<ResponsesApiResponse>(response);

    if (!response.ok) {
      if (
        !isTemporaryFailure(response.status) &&
        isCapabilityUnsupported(response.status, payload, text)
      ) {
        this.markResponsesUnsupported();
        return { kind: "fallback" };
      }

      return {
        kind: "error",
        result: {
          text: "",
          stderr:
            payload?.error?.message ??
            `Responses API HTTP ${response.status}: ${text.slice(0, 500)}`,
          exitCode: 1,
          timedOut: false,
        },
      };
    }

    this.clearResponsesUnsupported();
    const content = readResponsesContent(payload ?? {});
    if (!content) {
      return {
        kind: "error",
        result: {
          text: "",
          stderr: "Responses API returned empty content",
          exitCode: 1,
          timedOut: false,
        },
      };
    }

    return {
      kind: "success",
      result: {
        text: content,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    };
  }

  private async runChatCompletions(
    request: CodexBackendRequest,
    controller: AbortController,
  ): Promise<CodexRunResult> {
    const response = await fetch(buildChatCompletionsUrl(this.config.apiBaseUrl!), {
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
        messages: buildChatCompletionMessages(request),
      }),
      signal: controller.signal,
    });

    const { text, payload } = await parseJsonResponse<ChatCompletionResponse>(response);

    if (!response.ok) {
      return {
        text: "",
        stderr:
          payload?.error?.message ??
          `Chat Completions API HTTP ${response.status}: ${text.slice(0, 500)}`,
        exitCode: 1,
        timedOut: false,
      };
    }

    const content = readChatCompletionContent(payload ?? {}).trim();
    if (!content) {
      return {
        text: "",
        stderr: "Chat Completions API returned empty content",
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
  }

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
      if (this.shouldTryResponses()) {
        const responsesResult = await this.runResponses(request, controller);
        if (responsesResult.kind === "success") {
          return responsesResult.result;
        }
        if (responsesResult.kind === "error") {
          return responsesResult.result;
        }
      }

      return await this.runChatCompletions(request, controller);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
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
