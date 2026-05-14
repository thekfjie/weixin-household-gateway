import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  CodexProgressEvent,
  CodexResponseMode,
} from "./backend-types.js";

interface AcpResponseCollectorOptions {
  onProgress?: (event: CodexProgressEvent) => void;
  responseMode?: CodexResponseMode;
}

interface MessageRun {
  messageId?: string;
  chunks: string[];
  announced: boolean;
}

export class AcpResponseCollector {
  private readonly textChunks: string[] = [];

  private readonly messageRuns: MessageRun[] = [];

  private currentMessageRun: MessageRun | undefined;

  private readonly lastToolStatusById = new Map<string, string>();

  private sawThinking = false;

  private sawResponding = false;

  constructor(private readonly options: AcpResponseCollectorOptions = {}) {}

  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.announceCurrentMessageRun();
        this.currentMessageRun = undefined;
        this.options.onProgress?.({
          phase: "status",
          message: "available_commands_update",
          status: "ready",
        });
        return;
      case "agent_thought_chunk":
        this.announceCurrentMessageRun();
        this.currentMessageRun = undefined;
        if (!this.sawThinking) {
          this.sawThinking = true;
          this.options.onProgress?.({ phase: "thinking" });
        }
        return;
      case "agent_message_chunk":
        if (!this.sawResponding) {
          this.sawResponding = true;
          this.options.onProgress?.({ phase: "responding" });
        }
        if (update.content.type === "text") {
          this.textChunks.push(update.content.text);
          const messageId = update.messageId ?? undefined;
          if (
            !this.currentMessageRun ||
            (messageId && this.currentMessageRun.messageId !== messageId)
          ) {
            this.announceCurrentMessageRun();
            this.currentMessageRun = {
              ...(messageId ? { messageId } : {}),
              chunks: [],
              announced: false,
            };
            this.messageRuns.push(this.currentMessageRun);
          }
          this.currentMessageRun.chunks.push(update.content.text);
        }
        return;
      case "tool_call":
      case "tool_call_update": {
        this.announceCurrentMessageRun();
        this.currentMessageRun = undefined;
        const status = update.status ?? "in_progress";
        const toolCallId = update.toolCallId;
        if (toolCallId) {
          const key = `${toolCallId}:${status}`;
          if (this.lastToolStatusById.get(toolCallId) === key) {
            return;
          }
          this.lastToolStatusById.set(toolCallId, key);
        }
        const title = normalizeToolTitle({
          title: update.title,
          kind: update.kind,
        });
        const toolKind = update.kind ?? undefined;
        this.options.onProgress?.({
          phase: "tool_progress",
          message: buildToolProgressMessage({
            title,
            status,
          }),
          status,
          ...(toolCallId ? { toolCallId } : {}),
          ...(toolKind ? { toolKind } : {}),
          title,
        });
        return;
      }
      case "usage_update":
        return;
      default:
        this.announceCurrentMessageRun();
        this.currentMessageRun = undefined;
        return;
    }
  }

  toText(): string {
    if (this.options.responseMode === "final_message_run") {
      return this.toFinalMessageRunText();
    }
    return this.textChunks.join("").trim();
  }

  private toFinalMessageRunText(): string {
    for (let index = this.messageRuns.length - 1; index >= 0; index -= 1) {
      const text = this.messageRuns[index]?.chunks.join("").trim() ?? "";
      if (text) {
        return text;
      }
    }

    return this.textChunks.join("").trim();
  }

  private announceCurrentMessageRun(): void {
    if (!this.currentMessageRun || this.currentMessageRun.announced) {
      return;
    }

    const text = this.currentMessageRun.chunks.join("").trim();
    if (!text) {
      return;
    }

    this.currentMessageRun.announced = true;
    this.options.onProgress?.({
      phase: "visible_message_run",
      message: text,
    });
  }
}

function buildToolProgressMessage(params: {
  title: string;
  status: string;
}): string {
  const title = params.title.trim() || "tool";

  switch (params.status) {
    case "pending":
      return `准备执行：${title}`;
    case "in_progress":
      return `正在处理：${title}`;
    case "completed":
      return `已完成：${title}`;
    case "failed":
      return `执行失败：${title}`;
    default:
      return `正在处理：${title}`;
  }
}

function normalizeToolTitle(params: {
  title: string | null | undefined;
  kind: string | null | undefined;
}): string {
  const title = params.title?.trim();
  const kind = params.kind?.trim();
  const source = `${title ?? ""} ${kind ?? ""}`.toLowerCase();
  if (source.includes("image") && source.includes("generat")) {
    return "生成图片";
  }

  return title || kind || "tool";
}
