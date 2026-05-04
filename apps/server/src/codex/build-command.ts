import { CodexRuntimeConfig } from "../config/types.js";
import { CodexInvocation, CodexPlanPreview } from "./types.js";

export function buildCodexCommand(
  config: CodexRuntimeConfig,
  prompt: string,
): CodexInvocation {
  return {
    command: config.command,
    ...(config.codexHome ? { codexHome: config.codexHome } : {}),
    args: config.args,
    envMode: config.envMode,
    envPassthrough: config.envPassthrough,
    mode: config.mode,
    timeoutMs: config.timeoutMs,
    workspace: config.workspace,
    prompt,
  };
}

export function previewCodexArgv(
  invocation: CodexInvocation,
): CodexPlanPreview {
  return {
    workspace: invocation.workspace,
    argv: [invocation.command, ...invocation.args, "<prompt>"],
  };
}
