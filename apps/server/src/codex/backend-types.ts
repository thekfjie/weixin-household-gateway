import { UserRole } from "../config/types.js";
import { CodexRunResult } from "./types.js";

export interface CodexProgressEvent {
  phase:
    | "thinking"
    | "responding"
    | "status"
    | "tool_progress"
    | "visible_message_run";
  message?: string;
  status?: string;
  toolCallId?: string;
  toolKind?: string;
  title?: string;
}

export type CodexResponseMode = "full_text" | "final_message_run";

export type CodexInputPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "message";
      role: "user" | "assistant";
      text: string;
    }
  | {
      type: "image";
      filePath: string;
      mimeType: string;
    };

export interface CodexBackendRequest {
  conversationId: string;
  prompt: string;
  bootstrapPrompt?: string;
  systemPrompt?: string;
  inputParts?: CodexInputPart[];
  promptCacheKey?: string;
  persistentSession?: boolean;
  role: UserRole;
  additionalDirectories?: string[];
  readOnlyDirectories?: string[];
  responseMode?: CodexResponseMode;
  onProgress?: (event: CodexProgressEvent) => void;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal | undefined;
}

export interface CodexBackend {
  run(request: CodexBackendRequest): Promise<CodexRunResult>;
  cancel(conversationId: string): void | Promise<void>;
  clearSession(conversationId: string): void;
  dispose(): void;
}
