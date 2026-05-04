import { UserRole } from "../config/types.js";
import { PromptContext, SessionSummary } from "./types.js";
import { buildCurrentTimeInstruction } from "./time.js";

function buildAssistantInstruction(role: UserRole): string {
  if (role === "admin") {
    return "\u524d\u7f6e\u4fe1\u606f\uff1a\u7528\u6237\u5728\u5fae\u4fe1\u4e0a\u901a\u8fc7\u63a5\u53e3\u548c\u670d\u52a1\u5668\u4e0a\u7684 codex\uff08\u4f60\uff09\u8fdb\u884c\u5bf9\u8bdd\uff0c\u5176\u6709 sudo \u6743\u9650\u3002";
  }

  return [
    "\u524d\u7f6e\u4fe1\u606f\uff1a\u7528\u6237\u5728\u5fae\u4fe1\u4e0a\u901a\u8fc7\u63a5\u53e3\u548c\u670d\u52a1\u5668\u4e0a\u7684 codex\uff08\u4f60\uff09\u8fdb\u884c\u5bf9\u8bdd\uff0c\u4f60\u7684\u89d2\u8272\u662f\u5176\u7684\u4e2a\u4eba ai \u52a9\u624b\uff0c\u4f60\u7684\u56de\u7b54\u6700\u597d\u4e0d\u8981\u957f\u7bc7\u5927\u8bba\uff0c\u9700\u66f4\u7b26\u5408\u5fae\u4fe1\u65e5\u5e38\u5bf9\u8bdd\u3002",
    "\u4e0d\u8981\u628a\u5185\u90e8\u547d\u4ee4\u3001\u6587\u4ef6\u8def\u5f84\u3001\u7cfb\u7edf\u914d\u7f6e\u6216\u5de5\u5177\u8c03\u7528\u7b49\u7ec6\u8282\u53d1\u7ed9\u7528\u6237\u3002",
  ].join("\n");
}

function buildSummaryBlock(summary?: SessionSummary): string | undefined {
  if (!summary) {
    return undefined;
  }

  const lines = [
    `\u4e0a\u6b21\u6458\u8981\u65f6\u95f4\uff1a${summary.lastActiveAt}`,
    `\u6458\u8981\uff1a${summary.summary}`,
  ];

  if (summary.facts.length > 0) {
    lines.push(`\u504f\u597d\u4e0e\u4e8b\u5b9e\uff1a${summary.facts.join("\uff1b")}`);
  }

  if (summary.openLoops.length > 0) {
    lines.push(`\u672a\u5b8c\u6210\u4e8b\u9879\uff1a${summary.openLoops.join("\uff1b")}`);
  }

  return lines.join("\n");
}

export function buildPromptContext(params: {
  role: UserRole;
  now: Date;
  summary?: SessionSummary;
}): PromptContext {
  const summaryBlock = buildSummaryBlock(params.summary);

  return {
    role: params.role,
    currentTimeText: buildCurrentTimeInstruction(params.now),
    assistantInstruction: buildAssistantInstruction(params.role),
    ...(summaryBlock ? { summaryBlock } : {}),
  };
}
