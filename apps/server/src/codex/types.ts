import { CodexMode } from "../config/types.js";

export interface CodexInvocation {
  args: string[];
  command: string;
  codexHome?: string | undefined;
  envMode: "inherit" | "minimal";
  envPassthrough: string[];
  mode: CodexMode;
  timeoutMs: number;
  workspace: string;
  prompt: string;
}

export interface CodexPlanPreview {
  argv: string[];
  workspace: string;
}

export interface CodexRunResult {
  text: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}
