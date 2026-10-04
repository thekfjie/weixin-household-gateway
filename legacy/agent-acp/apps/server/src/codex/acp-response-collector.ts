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
  chunks: string[];
}

export class AcpResponseCollector {
  private readonly textChunks: string[] = [];

  private readonly messageRuns: MessageRun[] = [];

  private currentMessageRun: MessageRun | undefined;

  private sawThinking = false;

  private sawResponding = false;

  constructor(private readonly options: AcpResponseCollectorOptions = {}) {}

  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
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
          if (!this.currentMessageRun) {
            this.currentMessageRun = { chunks: [] };
            this.messageRuns.push(this.currentMessageRun);
          }
          this.currentMessageRun.chunks.push(update.content.text);
        }
        return;
      case "usage_update":
        return;
      default:
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
}
