import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  SessionId,
  type PermissionOption,
  type RequestPermissionRequest,
  type AuthMethod,
  type AuthMethodEnvVar,
} from "@agentclientprotocol/sdk";
import { CodexRuntimeConfig, UserRole } from "../config/types.js";
import { isInsideDirectory } from "../files/path-utils.js";
import { buildChildEnv } from "./run-codex.js";
import { AcpResponseCollector } from "./acp-response-collector.js";
import { reviewFamilyPermission } from "./permission-review.js";

const ACP_AUTH_ENV_KEYS = [
  "CODEX_CLI_HOME",
  "CODEX_CLI_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

interface SessionPermissionContext {
  role: UserRole;
  additionalDirectories: string[];
  readOnlyDirectories: string[];
}

interface PermissionDecision {
  allowed: boolean;
  reason: string;
  optionId?: string;
}

function describeToolCall(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
}): string {
  return update.title ?? update.kind ?? update.toolCallId ?? "tool";
}

function formatToolCallDetails(params: RequestPermissionRequest): string {
  const parts: string[] = [];
  const title = describeToolCall(params.toolCall);
  parts.push(title);
  if (params.toolCall.kind) {
    parts.push(`kind=${params.toolCall.kind}`);
  }
  const locations =
    params.toolCall.locations
      ?.map((item) => item.path)
      .filter((item): item is string => Boolean(item))
      .slice(0, 4) ?? [];
  if (locations.length > 0) {
    parts.push(`paths=${locations.join(",")}`);
  }
  if (params.toolCall.content?.length) {
    const textSnippets = params.toolCall.content
      .map((item) =>
        item.type === "content" && item.content.type === "text"
          ? item.content.text
          : undefined,
      )
      .filter((item): item is string => Boolean(item))
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2);
    if (textSnippets.length > 0) {
      parts.push(`content=${textSnippets.join(" | ")}`);
    }
  }

  return parts.join(" ");
}

function defaultHome(): string | undefined {
  const home = os.homedir();
  if (home && home !== ".") {
    return home;
  }

  return process.env.HOME ?? process.env.USERPROFILE;
}

function cleanupSubprocessStdio(proc: ChildProcess): void {
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {

      }
    }
  }
}

function readCodexAuthJson(env: NodeJS.ProcessEnv): Record<string, string> {
  const codexHome =
    env.CODEX_HOME ??
    (env.HOME ? path.join(env.HOME, ".codex") : undefined) ??
    (env.USERPROFILE ? path.join(env.USERPROFILE, ".codex") : undefined);

  if (!codexHome) {
    return {};
  }

  const authPath = path.join(codexHome, "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      unknown
    >;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function buildAcpEnv(config: CodexRuntimeConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...buildChildEnv(config) };
  for (const key of ACP_AUTH_ENV_KEYS) {
    env[key] ??= process.env[key];
  }

  const configuredCodexHome =
    config.codexHome ?? env.CODEX_HOME ?? env.CODEX_CLI_HOME;
  if (configuredCodexHome) {
    env.CODEX_HOME = path.resolve(configuredCodexHome);
  }

  const home = env.HOME ?? env.USERPROFILE ?? defaultHome();

  if (home) {
    env.HOME ??= home;
    env.USERPROFILE ??= home;
    env.CODEX_HOME ??= path.join(home, ".codex");
  }

  const codexAuth = readCodexAuthJson(env);
  const apiKey =
    env.CODEX_CLI_API_KEY ??
    env.OPENAI_API_KEY ??
    env.CODEX_API_KEY ??
    codexAuth.OPENAI_API_KEY ??
    codexAuth.CODEX_API_KEY;
  env.OPENAI_API_KEY ??= apiKey;
  env.CODEX_API_KEY ??= apiKey;

  return env;
}

function authMethodType(method: AuthMethod): string {
  return "type" in method && method.type ? method.type : "agent";
}

function isEnvAuthMethod(
  method: AuthMethod,
): method is AuthMethodEnvVar & { type: "env_var" } {
  return "type" in method && method.type === "env_var";
}

export function selectAcpAuthMethod(
  methods: AuthMethod[] | undefined,
  env: NodeJS.ProcessEnv,
): AuthMethod | undefined {
  if (!methods?.length) {
    return undefined;
  }

  const readyEnvMethod = methods.find((method) => {
    if (!isEnvAuthMethod(method)) {
      return false;
    }

    return method.vars.every((variable) => {
      if (variable.optional) {
        return true;
      }
      return Boolean(env[variable.name]);
    });
  });
  if (readyEnvMethod) {
    return readyEnvMethod;
  }

  return undefined;
}

export function hasAcpEnvAuth(config: CodexRuntimeConfig): boolean {
  const env = buildAcpEnv(config);
  return Boolean(env.OPENAI_API_KEY || env.CODEX_API_KEY);
}

function describeAuthMethods(
  methods: AuthMethod[] | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (!methods?.length) {
    return "none";
  }

  return methods
    .map((method) => {
      const type = authMethodType(method);
      if (!isEnvAuthMethod(method)) {
        return `${method.id}:${type}`;
      }

      const vars = method.vars
        .map((variable) => `${variable.name}=${Boolean(env[variable.name])}`)
        .join(",");
      return `${method.id}:${type}[${vars}]`;
    })
    .join(" ");
}

function requiredAuthEnvVars(methods: AuthMethod[] | undefined): string[] {
  const names = new Set<string>();
  for (const method of methods ?? []) {
    if (!isEnvAuthMethod(method)) {
      continue;
    }

    for (const variable of method.vars) {
      if (!variable.optional) {
        names.add(variable.name);
      }
    }
  }

  return [...names].sort();
}

function normalizePathList(paths: string[] | undefined): string[] {
  if (!paths?.length) {
    return [];
  }

  return [
    ...new Set(
      paths
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    ),
  ];
}

function extractPathsFromRawInput(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const result: string[] = [];
  const pushIfPath = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.trim()) {
      const trimmed = candidate.trim();
      if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
        result.push(path.resolve(trimmed));
      }
    }
  };

  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "path" ||
      key === "cwd" ||
      key.endsWith("Path") ||
      key.endsWith("_path")
    ) {
      pushIfPath(candidate);
      continue;
    }
    if (
      (key === "paths" || key.endsWith("Paths") || key.endsWith("_paths")) &&
      Array.isArray(candidate)
    ) {
      for (const item of candidate) {
        pushIfPath(item);
      }
    }
  }

  return [...new Set(result)];
}

function extractAbsolutePathsFromText(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s"'`=:(])((?:\/[^\s"'`)<>\]]+)+|[A-Za-z]:[\\/][^\s"'`)<>\]]+)/g,
  );
  if (!matches) {
    return [];
  }

  const paths = matches
    .map((item) =>
      item.replace(/^[\s"'`=:(]+/, "").replace(/[\s"'`),:;]+$/, ""),
    )
    .filter((item) => path.isAbsolute(item) || /^[A-Za-z]:[\\/]/.test(item))
    .map((item) => path.resolve(item));

  return [...new Set(paths)];
}

function extractPathsFromToolCallText(params: RequestPermissionRequest): string[] {
  const snippets = params.toolCall.content
    ?.map((item) =>
      item.type === "content" && item.content.type === "text"
        ? item.content.text
        : "",
    )
    .filter(Boolean) ?? [];

  const paths = snippets.flatMap((snippet) => extractAbsolutePathsFromText(snippet));
  return [...new Set(paths)];
}

function extractToolCallText(params: RequestPermissionRequest): string {
  return (
    params.toolCall.content
      ?.map((item) =>
        item.type === "content" && item.content.type === "text"
          ? item.content.text
          : "",
      )
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

const FAMILY_BLOCKED_COMMANDS =
  /\b(curl|wget|ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|apt|apt-get|yum|dnf|brew|systemctl|service|mount|umount|docker|kubectl|rm|dd|mkfs|fdisk|iptables|reboot|shutdown|halt|poweroff)\b/;

function isBlockedExecuteText(text: string, role: UserRole): boolean {
  if (role === "admin") {
    return false;
  }
  return FAMILY_BLOCKED_COMMANDS.test(text);
}

function choosePermissionOption(
  options: PermissionOption[],
  preferredKinds: ReadonlySet<string>,
): PermissionOption | undefined {
  for (const option of options) {
    if (preferredKinds.has(option.kind)) {
      return option;
    }
  }

  return options[0];
}

function decidePermission(
  config: CodexRuntimeConfig,
  context: SessionPermissionContext | undefined,
  params: RequestPermissionRequest,
): PermissionDecision {
  const role = context?.role ?? "family";
  const allowedRoots = normalizePathList([
    config.workspace,
    ...(context?.additionalDirectories ?? []),
  ]);
  const readOnlyRoots = normalizePathList(context?.readOnlyDirectories);
  const touchedPaths = [
    ...(params.toolCall.locations?.map((item) => item.path) ?? []),
    ...extractPathsFromRawInput(params.toolCall.rawInput),
    ...extractPathsFromToolCallText(params),
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const kind = params.toolCall.kind ?? "other";
  const describeRoots = allowedRoots.join(", ") || config.workspace;

  const allowKinds = new Set<string>(["allow_once", "allow_always"]);
  const rejectKinds = new Set<string>(["reject_once", "reject_always"]);

  // admin 对所有操作放行（full-auto 模式的设计意图）
  if (role === "admin") {
    const option = choosePermissionOption(params.options, allowKinds);
    if (option) {
      return {
        allowed: true,
        reason: `allow admin ${kind} (unrestricted)`,
        optionId: option.optionId,
      };
    }
  }

  // 以下仅对 family 角色生效

  if (kind === "read") {
    if (
      touchedPaths.length > 0 &&
      touchedPaths.every((item) => allowedRoots.some((root) => isInsideDirectory(item, root)))
    ) {
      const option = choosePermissionOption(params.options, allowKinds);
      if (option) {
        return {
          allowed: true,
          reason: `allow read inside ${describeRoots}`,
          optionId: option.optionId,
        };
      }
    }
  }

  if (kind === "edit" || kind === "move" || kind === "delete") {
    if (
      touchedPaths.length > 0 &&
      touchedPaths.every(
        (item) =>
          allowedRoots.some((root) => isInsideDirectory(item, root)) &&
          !readOnlyRoots.some((root) => isInsideDirectory(item, root)),
      )
    ) {
      const option = choosePermissionOption(params.options, allowKinds);
      if (option) {
        return {
          allowed: true,
          reason: `allow ${kind} inside writable session workspace`,
          optionId: option.optionId,
        };
      }
    }
  }

  if (kind === "execute") {
    const contentText = extractToolCallText(params).toLowerCase();
    const touchesOnlyAllowedRoots =
      touchedPaths.length > 0 &&
      touchedPaths.every((item) => allowedRoots.some((root) => isInsideDirectory(item, root)));

    if (
      touchesOnlyAllowedRoots &&
      !isBlockedExecuteText(contentText, role)
    ) {
      const option = choosePermissionOption(params.options, allowKinds);
      if (option) {
        return {
          allowed: true,
          reason: "allow execute inside controlled workspace",
          optionId: option.optionId,
        };
      }
    }

    if (
      role === "family" &&
      touchedPaths.length === 0 &&
      !isBlockedExecuteText(contentText, role)
    ) {
      const option = choosePermissionOption(params.options, allowKinds);
      if (option) {
        return {
          allowed: true,
          reason: "allow execute without explicit path scope inside family workspace flow",
          optionId: option.optionId,
        };
      }
    }
  }

  const rejectOption = choosePermissionOption(params.options, rejectKinds);
  return {
    allowed: false,
    reason:
      touchedPaths.length > 0
        ? `blocked ${kind} outside controlled workspace`
        : `blocked ${kind}; no safe path scope detected`,
    ...(rejectOption ? { optionId: rejectOption.optionId } : {}),
  };
}

function collectTouchedPaths(
  params: RequestPermissionRequest,
): string[] {
  return [
    ...(params.toolCall.locations?.map((item) => item.path) ?? []),
    ...extractPathsFromRawInput(params.toolCall.rawInput),
    ...extractPathsFromToolCallText(params),
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function shouldReviewDeniedFamilyPermission(params: {
  toolKind: string;
  touchedPaths: string[];
  contentText: string;
  decisionReason: string;
}): boolean {
  if (
    /blocked execute outside controlled workspace/i.test(params.decisionReason)
  ) {
    return true;
  }

  if (/no safe path scope detected/i.test(params.decisionReason)) {
    return true;
  }

  if (
    /blocked (read|write|edit|move|delete) outside controlled workspace/i.test(
      params.decisionReason,
    )
  ) {
    return true;
  }

  if (
    params.toolKind === "execute" &&
    /\b(docker|kubectl|python|python3|node|bash|sh|unzip|pandoc|libreoffice|ffmpeg)\b/i.test(
      params.contentText,
    )
  ) {
    return true;
  }

  return false;
}

export class AcpConnection {
  private process: ChildProcess | undefined;

  private connection: ClientSideConnection | undefined;

  private ready = false;

  private loadSessionSupported = false;

  private additionalDirectoriesSupported = false;

  private readonly collectors = new Map<string, AcpResponseCollector>();

  private readonly sessionPermissions = new Map<SessionId, SessionPermissionContext>();

  private readonly lastPermissionDecisionBySession = new Map<SessionId, string>();

  constructor(
    private readonly config: CodexRuntimeConfig,
    private readonly onExit: () => void,
  ) {}

  registerCollector(sessionId: SessionId, collector: AcpResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  setSessionPermissions(
    sessionId: SessionId,
    context: SessionPermissionContext,
  ): void {
    this.sessionPermissions.set(sessionId, {
      role: context.role,
      additionalDirectories: normalizePathList(context.additionalDirectories),
      readOnlyDirectories: normalizePathList(context.readOnlyDirectories),
    });
  }

  clearSessionPermissions(sessionId: SessionId): void {
    this.sessionPermissions.delete(sessionId);
    this.lastPermissionDecisionBySession.delete(sessionId);
  }

  consumeLastPermissionDecision(sessionId: SessionId): string | undefined {
    const message = this.lastPermissionDecisionBySession.get(sessionId);
    if (message) {
      this.lastPermissionDecisionBySession.delete(sessionId);
    }
    return message;
  }

  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }

    const env = buildAcpEnv(this.config);
    const acpArgs = [...this.config.acpArgs];
    if (this.config.roleOverrides?.model) {
      acpArgs.push("-c", `model=${JSON.stringify(this.config.roleOverrides.model)}`);
    }
    if (this.config.roleOverrides?.reasoningEffort) {
      acpArgs.push(
        "-c",
        `model_reasoning_effort=${JSON.stringify(this.config.roleOverrides.reasoningEffort)}`,
      );
    }

    const proc = spawn(this.config.acpCommand, acpArgs, {
      cwd: this.config.workspace,
      env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.process = proc;

    const subprocessError = new Promise<never>((_resolve, reject) => {
      proc.once("error", (error) => {
        cleanupSubprocessStdio(proc);
        reject(error);
      });
    });

    proc.once("exit", (code) => {
      console.warn(`[codex:acp] subprocess exited: ${code ?? "unknown"}`);
      cleanupSubprocessStdio(proc);
      this.ready = false;
      this.loadSessionSupported = false;
      this.additionalDirectoriesSupported = false;
      this.connection = undefined;
      this.process = undefined;
      this.collectors.clear();
      this.sessionPermissions.clear();
      this.lastPermissionDecisionBySession.clear();
      this.onExit();
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error("ACP subprocess did not expose stdio pipes");
    }

    const writable = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call":
            console.log(
              `[codex:acp] tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`,
            );
            break;
          case "tool_call_update":
            if (update.status) {
              console.log(
                `[codex:acp] tool_call_update: ${describeToolCall(update)} -> ${update.status}`,
              );
            }
            break;
          case "agent_thought_chunk":
            break;
        }

        this.collectors.get(params.sessionId)?.handleUpdate(params);
      },
      requestPermission: async (params) => {
        let decision = decidePermission(
          this.config,
          this.sessionPermissions.get(params.sessionId),
          params,
        );
        const detail = formatToolCallDetails(params);
        const permissionContext = this.sessionPermissions.get(params.sessionId);
        const role = permissionContext?.role ?? "family";
        const touchedPaths = collectTouchedPaths(params);
        const contentText = extractToolCallText(params);

        if (
          !decision.allowed &&
          role === "family" &&
          shouldReviewDeniedFamilyPermission({
            toolKind: params.toolCall.kind ?? "other",
            touchedPaths,
            contentText,
            decisionReason: decision.reason,
          })
        ) {
          const reviewed = await reviewFamilyPermission({
            config: this.config.permissionReview,
            toolKind: params.toolCall.kind ?? "other",
            detail,
            contentText,
            touchedPaths,
          });
          if (reviewed?.allow) {
            const allowOption = choosePermissionOption(
              params.options,
              new Set<string>(["allow_once", "allow_always"]),
            );
            if (allowOption) {
              decision = {
                allowed: true,
                reason: `allow family after model review: ${reviewed.reason}`,
                optionId: allowOption.optionId,
              };
            }
          } else if (reviewed?.reason) {
            decision = {
              ...decision,
              reason: `${decision.reason}; ${reviewed.reason}`,
            };
          }
        }

        this.lastPermissionDecisionBySession.set(
          params.sessionId,
          `${decision.reason}: ${detail}`,
        );
        if (decision.allowed && decision.optionId) {
          console.log(
            `[codex:acp] permission request allowed: ${decision.reason}: ${detail}`,
          );
          return {
            outcome: {
              outcome: "selected",
              optionId: decision.optionId,
            },
          };
        }
        console.warn(
          `[codex:acp] permission request denied: ${decision.reason}: ${detail}`,
        );
        return {
          outcome: {
            ...(decision.optionId
              ? { outcome: "selected", optionId: decision.optionId }
              : { outcome: "cancelled" }),
          },
        };
      },
    }), stream);

    const initializeResponse = await Promise.race([
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "weixin-household-gateway",
          version: "0.1.0",
        },
        clientCapabilities: {},
      }),
      subprocessError,
    ]);

    const authMethods = initializeResponse.authMethods ?? [];
    this.loadSessionSupported =
      initializeResponse.agentCapabilities?.loadSession === true;
    this.additionalDirectoriesSupported =
      Boolean(
        initializeResponse.agentCapabilities?.sessionCapabilities
          ?.additionalDirectories,
      );
    console.log(
      `[codex:acp] auth methods: ${describeAuthMethods(authMethods, env)}`,
    );
    console.log(
      `[codex:acp] loadSession=${this.loadSessionSupported}, additionalDirectories=${this.additionalDirectoriesSupported}`,
    );

    const authMethod =
      this.config.acpAuthMode === "none"
        ? undefined
        : selectAcpAuthMethod(authMethods, env);
    if (authMethod) {
      await Promise.race([
        conn.authenticate({ methodId: authMethod.id }),
        subprocessError,
      ]);
      console.log(
        `[codex:acp] authenticated with ${authMethod.name} (${authMethod.id})`,
      );
    } else if (authMethods.length > 0 && this.config.acpAuthMode === "env") {
      const required = requiredAuthEnvVars(authMethods).join(" or ");
      throw new Error(
        `Set ${required || "OPENAI_API_KEY or CODEX_API_KEY"} in the service environment for codex-acp`,
      );
    } else if (authMethods.length > 0) {
      console.log(
        `[codex:acp] skipping explicit authenticate (CODEX_*_ACP_AUTH_MODE=${this.config.acpAuthMode}); relying on agent login state`,
      );
    }

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  dispose(): void {
    this.ready = false;
    this.loadSessionSupported = false;
    this.additionalDirectoriesSupported = false;
    this.collectors.clear();
    this.sessionPermissions.clear();
    this.lastPermissionDecisionBySession.clear();
    this.connection = undefined;
    if (this.process) {
      const proc = this.process;
      cleanupSubprocessStdio(proc);
      proc.kill();
      this.process = undefined;
    }
  }

  supportsLoadSession(): boolean {
    return this.loadSessionSupported;
  }

  supportsAdditionalDirectories(): boolean {
    return this.additionalDirectoriesSupported;
  }
}
