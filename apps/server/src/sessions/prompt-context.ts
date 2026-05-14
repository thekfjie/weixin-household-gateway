import { UserRole } from "../config/types.js";
import { PromptContext, SessionSummary } from "./types.js";

function buildCompactSummary(summary?: SessionSummary): string | undefined {
  if (!summary?.summary.trim()) {
    return undefined;
  }

  const lines = [summary.summary.trim()];

  if (summary.facts.length > 0) {
    lines.push(`Facts: ${summary.facts.join("；")}`);
  }

  if (summary.openLoops.length > 0) {
    lines.push(`Open loops: ${summary.openLoops.join("；")}`);
  }

  return lines.join("\n");
}

export function buildPromptContext(params: {
  role: UserRole;
  assistantInstruction: string;
  summary?: SessionSummary;
}): PromptContext & { summaryText?: string } {
  const summaryText = buildCompactSummary(params.summary);

  return {
    role: params.role,
    assistantInstruction: params.assistantInstruction,
    ...(summaryText ? { summaryText } : {}),
  };
}
