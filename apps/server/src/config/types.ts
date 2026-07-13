export type UserRole = "admin" | "family";

export type CodexMode = "suggest" | "auto-edit" | "full-auto";
export type CodexEnvMode = "inherit" | "minimal";
export type CodexBackendKind = "cli" | "acp" | "api";
export type CodexAcpAuthMode = "auto" | "env" | "none";
export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type CodexProviderRoute = "admin-acp" | "family-api" | "family-acp";

export interface CodexRoleOverrides {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface CodexProviderProfile {
  name: string;
  displayName?: string;
  backend?: CodexBackendKind;
  apiBaseUrl?: string;
  apiKey?: string;
  apiModel?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  codexHome?: string;
  acpArgs: string[];
  envOverrides: Record<string, string>;
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
  acpWorkspaceIsolation: boolean;
  apiBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  apiModel: string;
  apiPromptCacheKeyPrefix: string;
  codexHome?: string | undefined;
  envOverrides: Record<string, string>;
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

export interface PromptTemplateConfig {
  adminAcp: string;
  adminApi: string;
  familyAcp: string;
  familyApi: string;
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
  turnMessageLimit: number;
  adminProgressEnabled: boolean;
  familyProgressEnabled: boolean;
  familyApiStreamingEnabled: boolean;
}

export interface SessionConfig {
  adminAutoRotateEnabled: boolean;
  familyAutoRotateEnabled: boolean;
  familyHotIdleMinutes: number;
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
    providers: CodexProviderProfile[];
  };
  prompts: PromptTemplateConfig;
  familyPolicy: FamilyPolicyConfig;
  fileSend: FileSendConfig;
}
