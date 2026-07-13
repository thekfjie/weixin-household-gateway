import { CodexReasoningEffort } from "./types.js";

export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

// Keep this table aligned with the catalog bundled in @openai/codex 0.144.3.
const CODEX_MODEL_REASONING_EFFORTS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.2": ["low", "medium", "high", "xhigh"],
  "codex-auto-review": ["low", "medium", "high", "xhigh"],
} as const satisfies Record<string, readonly CodexReasoningEffort[]>;

export function isCodexReasoningEffort(
  value: string,
): value is CodexReasoningEffort {
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function getCodexModelReasoningEfforts(
  model: string,
): readonly CodexReasoningEffort[] | undefined {
  const normalized = model.trim().toLowerCase();
  return CODEX_MODEL_REASONING_EFFORTS[
    normalized as keyof typeof CODEX_MODEL_REASONING_EFFORTS
  ];
}

export function isCodexModelReasoningEffortSupported(
  model: string,
  effort: CodexReasoningEffort,
): boolean {
  const supported = getCodexModelReasoningEfforts(model);
  return !supported || supported.includes(effort);
}
