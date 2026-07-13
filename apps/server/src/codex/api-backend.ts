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
    delta?: {
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

interface ApiStreamChunk {
  type?: string;
  delta?: string;
  text?: string;
  output_text?: string;
  response?: ResponsesApiResponse;
  choices?: Array<{
    delta?: {
      content?: string;
    };
    text?: string;
  }>;
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

function isStreamingUnsupported(
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

  return (
    /\b(stream|streaming|sse|event-stream)\b/.test(message) &&
    /(unsupported|not supported|unknown|invalid|unrecognized|unexpected|not found|disabled|extra fields? not permitted)/.test(
      message,
    )
  );
}

function isReasoningParameterUnsupported(
  status: number,
  payload:
    | ChatCompletionResponse
    | ResponsesApiResponse
    | undefined,
  responseText: string,
): boolean {
  if (status !== 400 && status !== 422) {
    return false;
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
  if (!/reasoning(?:[._\s-]effort)?/.test(message)) {
    return false;
  }

  return (
    /(?:unknown|unrecognized|unexpected|unsupported|invalid)\s+(?:request\s+)?(?:parameter|field|argument|property)/.test(
      message,
    ) ||
    /(?:parameter|field|argument|property).*(?:unknown|unrecognized|unexpected|unsupported|not supported|not permitted)/.test(
      message,
    ) ||
    /does not support (?:the )?(?:parameter|field|argument|property)/.test(
      message,
    ) ||
    /extra (?:inputs?|fields?|properties?).*not permitted/.test(message)
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

function isEventStream(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ??
    false
  );
}

function extractStreamDelta(payload: ApiStreamChunk): string {
  const type = payload.type ?? "";
  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta" ||
    type.endsWith(".delta")
  ) {
    return payload.delta ?? payload.text ?? "";
  }

  return (
    payload.delta ??
    payload.output_text ??
    payload.choices?.[0]?.delta?.content ??
    payload.choices?.[0]?.text ??
    ""
  );
}

function extractStreamFinalText(payload: ApiStreamChunk): string {
  if (payload.response) {
    return readResponsesContent(payload.response);
  }

  return payload.output_text ?? "";
}

async function readEventStream(params: {
  response: Response;
  onTextDelta?: (delta: string) => void;
}): Promise<{ text: string; rawText: string; finalPayload?: ApiStreamChunk }> {
  if (!params.response.body) {
    return { text: "", rawText: "" };
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let rawText = "";
  let finalPayload: ApiStreamChunk | undefined;

  const handleEventData = (data: string): void => {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") {
      return;
    }

    try {
      const payload = JSON.parse(trimmed) as ApiStreamChunk;
      finalPayload = payload;
      const finalText = extractStreamFinalText(payload);
      if (finalText) {
        text = finalText;
        return;
      }

      const delta = extractStreamDelta(payload);
      if (delta) {
        text += delta;
        params.onTextDelta?.(delta);
      }
    } catch {
      rawText += trimmed;
    }
  };

  const drainEvents = (): void => {
    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const eventText = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const data = eventText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      handleEventData(data);
      boundaryIndex = buffer.indexOf("\n\n");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      drainEvents();
    }
    if (done) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n");
      if (buffer.trim()) {
        const data = buffer
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        handleEventData(data);
      }
      break;
    }
  }

  return {
    text: text.trim(),
    rawText,
    ...(finalPayload ? { finalPayload } : {}),
  };
}

export class ApiCodexBackend implements CodexBackend {
  private responsesUnsupportedUntil = 0;

  private responsesStreamUnsupportedUntil = 0;

  private chatStreamUnsupportedUntil = 0;

  private responsesReasoningUnsupportedUntil = 0;

  private chatReasoningUnsupportedUntil = 0;

  private readonly activeControllers = new Map<string, AbortController>();

  private readonly cancelledConversations = new Set<string>();

  constructor(private readonly config: CodexRuntimeConfig) {}

  private shouldTryResponses(): boolean {
    return Date.now() >= this.responsesUnsupportedUntil;
  }

  private shouldTryResponsesStream(): boolean {
    return Date.now() >= this.responsesStreamUnsupportedUntil;
  }

  private shouldTryChatStream(): boolean {
    return Date.now() >= this.chatStreamUnsupportedUntil;
  }

  private markResponsesUnsupported(): void {
    this.responsesUnsupportedUntil = Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
  }

  private markResponsesStreamUnsupported(): void {
    this.responsesStreamUnsupportedUntil =
      Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
  }

  private markChatStreamUnsupported(): void {
    this.chatStreamUnsupportedUntil = Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
  }

  private clearResponsesUnsupported(): void {
    this.responsesUnsupportedUntil = 0;
  }

  private clearResponsesStreamUnsupported(): void {
    this.responsesStreamUnsupportedUntil = 0;
  }

  private clearChatStreamUnsupported(): void {
    this.chatStreamUnsupportedUntil = 0;
  }

  private shouldSendReasoning(wireApi: "responses" | "chat"): boolean {
    const unsupportedUntil =
      wireApi === "responses"
        ? this.responsesReasoningUnsupportedUntil
        : this.chatReasoningUnsupportedUntil;
    return Date.now() >= unsupportedUntil;
  }

  private markReasoningUnsupported(wireApi: "responses" | "chat"): void {
    if (wireApi === "responses") {
      this.responsesReasoningUnsupportedUntil =
        Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
      return;
    }
    this.chatReasoningUnsupportedUntil =
      Date.now() + RESPONSES_UNSUPPORTED_TTL_MS;
  }

  private clearReasoningUnsupported(wireApi: "responses" | "chat"): void {
    if (wireApi === "responses") {
      this.responsesReasoningUnsupportedUntil = 0;
      return;
    }
    this.chatReasoningUnsupportedUntil = 0;
  }

  private async fetchApi(params: {
    wireApi: "responses" | "chat";
    url: string;
    requestBody: Record<string, unknown>;
    controller: AbortController;
  }): Promise<Response> {
    const reasoningEffort = this.config.roleOverrides?.reasoningEffort;
    const includeReasoning = Boolean(
      reasoningEffort && this.shouldSendReasoning(params.wireApi),
    );
    const requestBody = includeReasoning
      ? {
          ...params.requestBody,
          ...(params.wireApi === "responses"
            ? { reasoning: { effort: reasoningEffort } }
            : { reasoning_effort: reasoningEffort }),
        }
      : params.requestBody;
    const send = (body: Record<string, unknown>): Promise<Response> =>
      fetch(params.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.controller.signal,
      });

    let response = await send(requestBody);
    if (!includeReasoning) {
      return response;
    }
    if (response.ok) {
      this.clearReasoningUnsupported(params.wireApi);
      return response;
    }

    const { text, payload } = await parseJsonResponse<
      ChatCompletionResponse | ResponsesApiResponse
    >(response.clone());
    if (!isReasoningParameterUnsupported(response.status, payload, text)) {
      return response;
    }

    this.markReasoningUnsupported(params.wireApi);
    response = await send(params.requestBody);
    return response;
  }

  private async runResponses(
    request: CodexBackendRequest,
    controller: AbortController,
  ): Promise<
    | { kind: "success"; result: CodexRunResult }
    | { kind: "fallback" }
    | { kind: "error"; result: CodexRunResult }
  > {
    const requestBody = {
      model: this.config.apiModel,
      instructions: request.systemPrompt?.trim() || undefined,
      prompt_cache_key: buildPromptCacheKey(
        this.config.apiPromptCacheKeyPrefix,
        request,
      ),
      input: buildResponsesInput(request),
    };
    if (request.onTextDelta && this.shouldTryResponsesStream()) {
      const streamResponse = await this.fetchApi({
        wireApi: "responses",
        url: buildResponsesUrl(this.config.apiBaseUrl!),
        requestBody: {
          ...requestBody,
          stream: true,
        },
        controller,
      });
      if (streamResponse.ok && isEventStream(streamResponse)) {
        this.clearResponsesUnsupported();
        this.clearResponsesStreamUnsupported();
        const streamResult = await readEventStream({
          response: streamResponse,
          onTextDelta: request.onTextDelta,
        });
        if (streamResult.text) {
          return {
            kind: "success",
            result: {
              text: streamResult.text,
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        this.markResponsesStreamUnsupported();
      } else {
        const { text, payload } =
          await parseJsonResponse<ResponsesApiResponse>(streamResponse);
        if (streamResponse.ok) {
          this.clearResponsesUnsupported();
          this.markResponsesStreamUnsupported();
          const content = readResponsesContent(payload ?? {});
          if (content) {
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
        } else if (isTemporaryFailure(streamResponse.status)) {
          return {
            kind: "error",
            result: {
              text: "",
              stderr:
                payload?.error?.message ??
                `Responses API stream HTTP ${streamResponse.status}: ${text.slice(0, 500)}`,
              exitCode: 1,
              timedOut: false,
            },
          };
        } else if (
          !streamResponse.ok &&
          isStreamingUnsupported(streamResponse.status, payload, text)
        ) {
          this.markResponsesStreamUnsupported();
        }
      }
    }

    const response = await this.fetchApi({
      wireApi: "responses",
      url: buildResponsesUrl(this.config.apiBaseUrl!),
      requestBody,
      controller,
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
    const requestBody = {
      model: this.config.apiModel,
      prompt_cache_key: buildPromptCacheKey(
        this.config.apiPromptCacheKeyPrefix,
        request,
      ),
      messages: buildChatCompletionMessages(request),
    };
    if (request.onTextDelta && this.shouldTryChatStream()) {
      const streamResponse = await this.fetchApi({
        wireApi: "chat",
        url: buildChatCompletionsUrl(this.config.apiBaseUrl!),
        requestBody: {
          ...requestBody,
          stream: true,
        },
        controller,
      });
      if (streamResponse.ok && isEventStream(streamResponse)) {
        this.clearChatStreamUnsupported();
        const streamResult = await readEventStream({
          response: streamResponse,
          onTextDelta: request.onTextDelta,
        });
        if (streamResult.text) {
          return {
            text: streamResult.text,
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        this.markChatStreamUnsupported();
      } else {
        const { text, payload } =
          await parseJsonResponse<ChatCompletionResponse>(streamResponse);
        if (streamResponse.ok) {
          this.markChatStreamUnsupported();
          const content = readChatCompletionContent(payload ?? {}).trim();
          if (content) {
            return {
              text: content,
              stderr: "",
              exitCode: 0,
              timedOut: false,
            };
          }
        } else if (isTemporaryFailure(streamResponse.status)) {
          return {
            text: "",
            stderr:
              payload?.error?.message ??
              `Chat Completions API stream HTTP ${streamResponse.status}: ${text.slice(0, 500)}`,
            exitCode: 1,
            timedOut: false,
          };
        } else if (
          !streamResponse.ok &&
          isStreamingUnsupported(streamResponse.status, payload, text)
        ) {
          this.markChatStreamUnsupported();
        }
      }
    }

    const response = await this.fetchApi({
      wireApi: "chat",
      url: buildChatCompletionsUrl(this.config.apiBaseUrl!),
      requestBody,
      controller,
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
    this.activeControllers.set(request.conversationId, controller);
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (request.signal?.aborted) {
        controller.abort();
      }
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
      const cancelled =
        timedOut &&
        (Boolean(request.signal?.aborted) ||
          this.cancelledConversations.has(request.conversationId));
      return {
        text: "",
        stderr: cancelled
          ? "API backend cancelled"
          : timedOut
          ? `API backend timed out after ${this.config.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
        exitCode: 1,
        timedOut: timedOut && !cancelled,
        cancelled,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (this.activeControllers.get(request.conversationId) === controller) {
        this.activeControllers.delete(request.conversationId);
      }
      this.cancelledConversations.delete(request.conversationId);
    }
  }

  cancel(conversationId: string): void {
    if (!this.activeControllers.has(conversationId)) {
      return;
    }
    this.cancelledConversations.add(conversationId);
    this.activeControllers.get(conversationId)?.abort();
  }

  clearSession(_conversationId: string): void {}

  dispose(): void {
    for (const conversationId of this.activeControllers.keys()) {
      this.cancel(conversationId);
    }
    this.activeControllers.clear();
    this.cancelledConversations.clear();
  }
}
