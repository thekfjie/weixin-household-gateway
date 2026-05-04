import { CodexReasoningEffort } from "./types.js";

const REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export function isCodexReasoningEffort(
  value: string,
): value is CodexReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}
