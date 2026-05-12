import { UserRole } from "../config/types.js";
import { CodexRunResult } from "./types.js";

export interface CodexProgressEvent {
  phase: "thinking" | "responding";
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
}

export interface CodexBackend {
  run(request: CodexBackendRequest): Promise<CodexRunResult>;
  clearSession(conversationId: string): void;
  dispose(): void;
}
