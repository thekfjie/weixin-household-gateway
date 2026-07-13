import { CodexProviderRoute, UserRole } from "../config/types.js";

export interface WechatAccountRecord {
  id: string;
  displayName?: string;
  role: UserRole;
  authToken: string;
  uin: string;
  baseUrl?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  wechatAccountId: string;
  contactId: string;
  role: UserRole;
  status: string;
  summaryText: string;
  memoryJson: string;
  contextToken: string;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  direction: "inbound" | "outbound";
  messageType: string;
  textContent?: string;
  filePath?: string;
  createdAt: string;
  sourceMessageId?: string;
}

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  localPath: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  outboundStatus: string;
  createdAt: string;
}

export interface CodexRoleSettingsRecord {
  role: UserRole;
  model?: string;
  reasoningEffort?: string;
  updatedAt: string;
}

export interface CodexProviderRouteSettingsRecord {
  route: CodexProviderRoute;
  providerName?: string;
  locked: boolean;
  updatedAt: string;
}
