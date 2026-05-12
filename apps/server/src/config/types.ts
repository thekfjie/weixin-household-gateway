export type UserRole = "admin" | "family";

export type CodexMode = "suggest" | "auto-edit" | "full-auto";
export type CodexEnvMode = "inherit" | "minimal";
export type CodexBackendKind = "cli" | "acp" | "api";
export type CodexAcpAuthMode = "auto" | "env" | "none";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CodexRoleOverrides {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface PermissionReviewConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
}

export interface CodexRuntimeConfig {
  backend: CodexBackendKind;
  command: string;
  args: string[];
  acpCommand: string;
  acpArgs: string[];
  acpAuthMode: CodexAcpAuthMode;
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiModel: string;
  apiPromptCacheKeyPrefix: string;
  codexHome?: string | undefined;
  mode: CodexMode;
  timeoutMs: number;
  workspace: string;
  envMode: CodexEnvMode;
  envPassthrough: string[];
  roleOverrides?: CodexRoleOverrides | undefined;
  permissionReview?: PermissionReviewConfig | undefined;
}

export interface FamilyPolicyConfig {
  stripReasoning: boolean;
  stripCommands: boolean;
  stripPaths: boolean;
  allowFileSend: boolean;
}

export interface FileSendConfig {
  allowedDirs: string[];
  maxBytes: number;
}

export interface ServerConfig {
  port: number;
  timezone: string;
  dataDir: string;
}

export interface WechatConfig {
  apiBaseUrl: string;
  cdnBaseUrl: string;
  channelVersion: string;
  routeTag?: string;
  typingRefreshMs: number;
  thinkingNoticeMs: number;
  replyChunkChars: number;
}

export interface SessionConfig {
  rotateIdleHours: number;
  rotateMaxTurns: number;
  rotateMaxEstimatedTokens: number;
}

export interface AppConfig {
  server: ServerConfig;
  wechat: WechatConfig;
  session: SessionConfig;
  codex: {
    admin: CodexRuntimeConfig;
    family: CodexRuntimeConfig;
  };
  familyPolicy: FamilyPolicyConfig;
  fileSend: FileSendConfig;
}
