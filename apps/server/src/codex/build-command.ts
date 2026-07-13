import { CodexRuntimeConfig } from "../config/types.js";
import { CodexInvocation, CodexPlanPreview } from "./types.js";

export function buildCodexCommand(
  config: CodexRuntimeConfig,
  prompt: string,
): CodexInvocation {
  const args = [...config.args];
  if (config.roleOverrides?.model) {
    args.push("-c", `model=${JSON.stringify(config.roleOverrides.model)}`);
  }
  if (config.roleOverrides?.reasoningEffort) {
    args.push(
      "-c",
      `model_reasoning_effort=${JSON.stringify(config.roleOverrides.reasoningEffort)}`,
    );
  }

  return {
    command: config.command,
    ...(config.codexHome ? { codexHome: config.codexHome } : {}),
    args,
    envMode: config.envMode,
    envPassthrough: config.envPassthrough,
    envOverrides: config.envOverrides,
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
