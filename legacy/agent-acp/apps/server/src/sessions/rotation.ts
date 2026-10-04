import path from "node:path";
import { AppConfig, UserRole } from "../config/types.js";
import { AppDatabase, SessionRecord } from "../storage/index.js";
import { shouldRotateSession } from "./service.js";

export function isNewBeijingCalendarDay(params: {
  previousAt: string;
  now: Date;
}): boolean {
  const previous = new Date(params.previousAt);
  if (Number.isNaN(previous.getTime())) {
    return false;
  }

  const previousDay = previous.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  const currentDay = params.now.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  return previousDay !== currentDay;
}

export function shouldRotateByThresholds(params: {
  session: SessionRecord;
  memory: { turnCount?: number; estimatedTokenCount?: number };
  config: AppConfig;
}): { shouldRotate: boolean; reason: string } {
  const now = new Date();
  if (
    isNewBeijingCalendarDay({
      previousAt: params.session.lastActiveAt,
      now,
    })
  ) {
    return {
      shouldRotate: true,
      reason: "crossed into a new Beijing calendar day",
    };
  }

  const idleDecision = shouldRotateSession({
    lastActiveAt: params.session.lastActiveAt,
    now,
    maxIdleHours: params.config.session.rotateIdleHours,
  });
  if (idleDecision.shouldRotate) {
    return idleDecision;
  }

  const turnCount = params.memory.turnCount ?? 0;
  if (turnCount >= params.config.session.rotateMaxTurns) {
    return {
      shouldRotate: true,
      reason: `turn count ${turnCount} >= ${params.config.session.rotateMaxTurns}`,
    };
  }

  const estimatedTokenCount = params.memory.estimatedTokenCount ?? 0;
  if (estimatedTokenCount >= params.config.session.rotateMaxEstimatedTokens) {
    return {
      shouldRotate: true,
      reason: `estimated tokens ${estimatedTokenCount} >= ${params.config.session.rotateMaxEstimatedTokens}`,
    };
  }

  return {
    shouldRotate: false,
    reason: "session is still warm",
  };
}

export function buildDayChangeUserNotice(params: {
  session: SessionRecord;
  role: UserRole;
  now: Date;
}): string | undefined {
  if (
    !isNewBeijingCalendarDay({
      previousAt: params.session.lastActiveAt,
      now: params.now,
    })
  ) {
    return undefined;
  }

  return params.role === "family"
    ? "昨天那段我先收起来了，我们接着聊；要回看上一段可以发 /last 或 /yesterday。"
    : "已按新的一天开启新对话；如需回看上一段，可用 /last 或 /yesterday。";
}

export function buildCrossDayNotice(params: {
  previousLastActiveAt: string;
  now: Date;
}): string | undefined {
  const previous = new Date(params.previousLastActiveAt);
  if (Number.isNaN(previous.getTime())) {
    return undefined;
  }

  const previousDay = previous.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  const currentDay = params.now.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  if (previousDay === currentDay) {
    return undefined;
  }

  return "前置信息：这条消息属于新的一天里的新对话；如当前语境需要，再自然参考上一段对话摘要，不要生硬提起。";
}

export function summarizeRecentMessagesInline(
  messages: ReturnType<AppDatabase["listSessionMessages"]>,
): string | undefined {
  const recent = messages
    .slice(-4)
    .map((message) => {
      const speaker = message.direction === "inbound" ? "用户" : "助手";
      const text = message.textContent?.trim() || "[非文本消息]";
      return `${speaker}：${text}`;
    })
    .filter(Boolean);

  return recent.length > 0 ? recent.join(" / ") : undefined;
}

export function summarizeCarryoverContext(params: {
  session: SessionRecord;
  recentMessages: ReturnType<AppDatabase["listSessionMessages"]>;
}): string {
  const lines: string[] = [];
  if (params.session.summaryText.trim()) {
    lines.push(`上段摘要：${params.session.summaryText.trim()}`);
  }

  const recent = params.recentMessages
    .slice(-6)
    .map((message) => {
      const speaker = message.direction === "inbound" ? "用户" : "助手";
      const text = message.textContent?.trim() || "[非文本消息]";
      return `${speaker}：${text}`;
    });

  if (recent.length > 0) {
    lines.push(`上段最近消息：${recent.join(" / ")}`);
  }

  return lines.join("\n").trim();
}

export function buildDeterministicSessionSummary(params: {
  session: SessionRecord;
  recentMessages: ReturnType<AppDatabase["listSessionMessages"]>;
}): string {
  const parts: string[] = [];

  const recentInline = summarizeRecentMessagesInline(params.recentMessages);
  if (recentInline) {
    parts.push(`最近对话：${recentInline}`);
  }

  const attachmentMentions = params.recentMessages
    .filter((message) => message.filePath)
    .slice(-3)
    .map((message) => path.basename(message.filePath ?? ""))
    .filter(Boolean);
  if (attachmentMentions.length > 0) {
    parts.push(`相关文件：${attachmentMentions.join("、")}`);
  }

  if (parts.length === 0) {
    return "";
  }

  return parts.join("\n");
}
