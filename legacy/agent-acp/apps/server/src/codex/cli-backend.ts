import { CodexRuntimeConfig } from "../config/types.js";
import { buildCodexCommand } from "./build-command.js";
import { CodexBackend, CodexBackendRequest } from "./backend-types.js";
import { runCodexInvocation } from "./run-codex.js";
import { CodexRunResult } from "./types.js";

export class CliCodexBackend implements CodexBackend {
  constructor(private readonly config: CodexRuntimeConfig) {}

  run(request: CodexBackendRequest): Promise<CodexRunResult> {
    return runCodexInvocation(buildCodexCommand(this.config, request.prompt));
  }

  clearSession(_conversationId: string): void {
    // The CLI backend is one-shot and has no process-local session cache.
  }

  dispose(): void {
    // Nothing to dispose for one-shot invocations.
  }
}
