import { UserRole } from "../config/types.js";

export interface SessionKey {
  wechatAccountId: string;
  contactId: string;
}

export interface SessionSummary {
  summary: string;
  facts: string[];
  openLoops: string[];
  lastActiveAt: string;
}

export interface PromptContext {
  role: UserRole;
  currentTimeText: string;
  assistantInstruction: string;
  summaryBlock?: string;
}
