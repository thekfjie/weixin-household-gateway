import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AppConfig,
  CodexProviderProfile,
  CodexProviderRoute,
  UserRole,
} from "../config/types.js";
import {
  CODEX_REASONING_EFFORTS,
  getCodexModelReasoningEfforts,
  isCodexModelReasoningEffortSupported,
  isCodexReasoningEffort,
} from "../config/reasoning.js";
import { AppDatabase, SessionRecord, WechatAccountRecord } from "../storage/index.js";
import {
  formatBeijingTime,
  buildSessionId,
  buildSessionWorkspacePaths,
  stringifySessionMemory,
  buildDeterministicSessionSummary,
  summarizeCarryoverContext,
  summarizeRecentMessagesInline,
} from "../sessions/index.js";
import type { SessionMemoryState } from "../sessions/index.js";
import type { ParsedCommand } from "./types.js";

const CODEX_MODEL_EXAMPLES = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
] as const;

const CODEX_ACTIONS = ["model", "reasoning", "reset"] as const;

function formatChoices(values: readonly string[]): string {
  return values.join(" | ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSessionSnapshot(params: {
  session: SessionRecord;
  database: AppDatabase;
}): string {
  const session = params.session;
  const parts = [
    `session=${session.id}`,
    `last=${session.lastActiveAt}`,
  ];
  if (session.summaryText.trim()) {
    parts.push(`summary=${session.summaryText.trim()}`);
  } else {
    parts.push("summary=(无)");
  }
  const recentInline = summarizeRecentMessagesInline(
    params.database.listSessionMessages(session.id, 4).reverse(),
  );
  if (recentInline) {
    parts.push(`recent=${recentInline}`);
  }
  return parts.join("\n");
}

export function findPreviousSession(params: {
  database: AppDatabase;
  session: SessionRecord;
}): SessionRecord | undefined {
  const sessions = params.database.listSessionsByPeer(
    params.session.wechatAccountId,
    params.session.contactId,
    10,
  );
  return sessions.find((candidate) => candidate.id !== params.session.id);
}

export function findYesterdaySession(params: {
  database: AppDatabase;
  session: SessionRecord;
}): SessionRecord | undefined {
  const sessions = params.database.listSessionsByPeer(
    params.session.wechatAccountId,
    params.session.contactId,
    20,
  );
  const today = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  return sessions.find((candidate) => {
    if (candidate.id === params.session.id) {
      return false;
    }
    const date = new Date(candidate.lastActiveAt);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    const candidateDay = date.toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
    });
    return candidateDay !== today;
  });
}

function listFilesForReply(directory: string, maxDepth: number): string[] {
  const files: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [
    { directory, depth: 0 },
  ];

  while (stack.length > 0 && files.length < 200) {
    const current = stack.pop();
    if (!current) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(current.directory, entry.name);
      if (entry.isFile()) {
        files.push(filePath);
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ directory: filePath, depth: current.depth + 1 });
      }
      if (files.length >= 200) break;
    }
  }

  return files;
}

function buildAccountsReply(params: {
  database: AppDatabase;
  role: UserRole;
}): string {
  if (params.role !== "admin") {
    return "这个账号命令只对 admin 开放。";
  }

  const accounts = params.database.listAccounts();
  if (accounts.length === 0) {
    return "当前还没有绑定微信账号。";
  }

  return [
    "已绑定微信账号：",
    ...accounts.map((account) =>
      [
        account.id,
        `role=${account.role}`,
        `status=${account.status}`,
        `updated=${account.updatedAt}`,
      ].join("  "),
    ),
  ].join("\n");
}

interface EffectiveCodexRouteSettings {
  route: CodexProviderRoute;
  provider: string;
  model: string;
  reasoning: string;
}

function codexRoutesForRole(role: UserRole): CodexProviderRoute[] {
  return role === "admin"
    ? ["admin-acp"]
    : ["family-api", "family-acp"];
}

function resolveEffectiveCodexRouteSettings(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  route: CodexProviderRoute;
  providerNameOverride?: string;
}): EffectiveCodexRouteSettings {
  const roleConfig = params.config.codex[params.role];
  const roleSettings = params.database.getCodexRoleSettings(params.role);
  const routeSettings = params.database.getCodexProviderRouteSettings(params.route);
  const configuredProviderName =
    params.providerNameOverride !== undefined
      ? params.providerNameOverride
      : routeSettings?.providerName;
  const provider = configuredProviderName
    ? findProviderProfile(params.config, configuredProviderName)
    : undefined;
  const providerModel =
    params.route === "family-api"
      ? provider?.apiModel ?? provider?.model
      : provider?.model ?? provider?.apiModel;
  const providerName = provider
    ? provider.name
    : configuredProviderName
      ? `${configuredProviderName}（缺失，回退 default）`
      : "default";

  return {
    route: params.route,
    provider: providerName,
    model:
      roleSettings?.model ??
      providerModel ??
      roleConfig.roleOverrides?.model ??
      roleConfig.apiModel,
    reasoning:
      roleSettings?.reasoningEffort ??
      provider?.reasoningEffort ??
      roleConfig.roleOverrides?.reasoningEffort ??
      "high",
  };
}

function formatCodexRoleSettings(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
}): string {
  const routes = codexRoutesForRole(params.role).map((route) =>
    resolveEffectiveCodexRouteSettings({ ...params, route }),
  );
  return [
    `role=${params.role}`,
    ...routes.map(
      (route) =>
        `${route.route}: provider=${route.provider}, model=${route.model}, reasoning=${route.reasoning}`,
    ),
  ].join("\n");
}

function buildUnsupportedReasoningReply(params: {
  role: UserRole;
  model: string;
  reasoning: string;
}): string {
  const supported = getCodexModelReasoningEfforts(params.model);
  return [
    `模型 ${params.model} 不支持思考强度 ${params.reasoning}。`,
    ...(supported ? [`该模型可选：${formatChoices(supported)}`] : []),
    supported?.length
      ? `请先设置兼容档位：/codex ${params.role} reasoning ${
          supported.includes("high") ? "high" : supported[0]
        }`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCodexUsage(role?: UserRole): string {
  const roleText = role ?? "admin|family";
  return [
    `用法：/codex ${roleText} [model <模型>|reasoning <强度>|reset]`,
    `角色：admin | family`,
    `操作：${formatChoices(CODEX_ACTIONS)}`,
    `模型示例：${formatChoices(CODEX_MODEL_EXAMPLES)}`,
    `思考强度：${formatChoices(CODEX_REASONING_EFFORTS)}`,
  ].join("\n");
}

function buildCodexSettingsReply(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  command: ParsedCommand;
  onChanged?: (role: UserRole) => void;
}): string {
  if (params.role !== "admin") {
    return "这个命令只对 admin 开放。";
  }

  const roleArg = params.command.args[0]?.trim().toLowerCase();
  if (!roleArg) {
    return [
      "当前 Codex 角色配置：",
      formatCodexRoleSettings({
        config: params.config,
        database: params.database,
        role: "admin",
      }),
      "",
      formatCodexRoleSettings({
        config: params.config,
        database: params.database,
        role: "family",
      }),
      "",
      "下一步：先选角色，再选操作。",
      "/codex admin",
      "/codex family",
      "/codex admin model gpt-5.6-sol",
      "/codex family reasoning high",
      "/codex admin reset",
      "",
      buildCodexUsage(),
    ].join("\n");
  }

  if (roleArg !== "admin" && roleArg !== "family") {
    return [
      `未知角色：${roleArg}`,
      "下一步请填角色：admin 或 family",
      buildCodexUsage(),
    ].join("\n");
  }

  const targetRole = roleArg as UserRole;
  const action = params.command.args[1]?.trim().toLowerCase();
  if (!action) {
    return [
      formatCodexRoleSettings({
        config: params.config,
        database: params.database,
        role: targetRole,
      }),
      "",
      `下一步可选操作：${formatChoices(CODEX_ACTIONS)}`,
      `/codex ${targetRole} model gpt-5.6-sol`,
      `/codex ${targetRole} reasoning high`,
      `/codex ${targetRole} reset`,
    ].join("\n");
  }

  if (action === "reset") {
    params.database.saveCodexRoleSettings({ role: targetRole, model: "", reasoningEffort: "" });
    params.onChanged?.(targetRole);
    return `已重置 ${targetRole} 的 Codex 配置。\n已刷新对应后端；后续该角色会回到默认配置。`;
  }

  if (action === "model") {
    const model = params.command.args[2]?.trim();
    if (!model) {
      return [
        `下一步请填模型名。`,
        `模型示例：${formatChoices(CODEX_MODEL_EXAMPLES)}`,
        `推荐：/codex ${targetRole} model gpt-5.6-sol`,
      ].join("\n");
    }
    const current = params.database.getCodexRoleSettings(targetRole);
    const incompatibleRoute = codexRoutesForRole(targetRole)
      .map((route) =>
        resolveEffectiveCodexRouteSettings({
          config: params.config,
          database: params.database,
          role: targetRole,
          route,
        }),
      )
      .find(
        (route) =>
          isCodexReasoningEffort(route.reasoning) &&
          !isCodexModelReasoningEffortSupported(model, route.reasoning),
      );
    if (incompatibleRoute) {
      return buildUnsupportedReasoningReply({
        role: targetRole,
        model,
        reasoning: incompatibleRoute.reasoning,
      });
    }
    params.database.saveCodexRoleSettings({
      role: targetRole,
      model,
      ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    });
    params.onChanged?.(targetRole);
    return `已设置 ${targetRole} 模型：${model}\n已刷新对应后端；后续该角色会按新模型运行。`;
  }

  if (action === "reasoning") {
    const reasoning = params.command.args[2]?.trim().toLowerCase();
    if (!reasoning || !isCodexReasoningEffort(reasoning)) {
      return [
        reasoning ? `未知思考强度：${reasoning}` : "下一步请填思考强度。",
        `可选：${formatChoices(CODEX_REASONING_EFFORTS)}`,
        `推荐：/codex ${targetRole} reasoning high`,
        `高强度：/codex ${targetRole} reasoning xhigh`,
        `最强：/codex ${targetRole} reasoning max`,
      ].join("\n");
    }
    const current = params.database.getCodexRoleSettings(targetRole);
    const incompatibleRoute = codexRoutesForRole(targetRole)
      .map((route) =>
        resolveEffectiveCodexRouteSettings({
          config: params.config,
          database: params.database,
          role: targetRole,
          route,
        }),
      )
      .find(
        (route) =>
          !isCodexModelReasoningEffortSupported(route.model, reasoning),
      );
    if (incompatibleRoute) {
      return buildUnsupportedReasoningReply({
        role: targetRole,
        model: incompatibleRoute.model,
        reasoning,
      });
    }
    params.database.saveCodexRoleSettings({
      role: targetRole,
      ...(current?.model ? { model: current.model } : {}),
      reasoningEffort: reasoning,
    });
    params.onChanged?.(targetRole);
    return `已设置 ${targetRole} 思考强度：${reasoning}\n已刷新对应后端；后续该角色会按新思考强度运行。`;
  }

  return [
    `未知操作：${action}`,
    `下一步可选操作：${formatChoices(CODEX_ACTIONS)}`,
    buildCodexUsage(targetRole),
  ].join("\n");
}

const PROVIDER_ROUTES: readonly CodexProviderRoute[] = [
  "admin-acp",
  "family-api",
  "family-acp",
];

function isProviderRoute(value: string | undefined): value is CodexProviderRoute {
  return Boolean(value && PROVIDER_ROUTES.includes(value as CodexProviderRoute));
}

function findProviderProfile(
  config: AppConfig,
  name: string,
): CodexProviderProfile | undefined {
  const normalized = name.toLowerCase();
  const exact = config.codex.providers.find(
    (profile) => profile.name.toLowerCase() === normalized,
  );
  if (exact) {
    return exact;
  }

  return config.codex.providers.find((profile) => {
    const displayName = profile.displayName?.toLowerCase() ?? "";
    return (
      profile.name.toLowerCase().includes(normalized) ||
      displayName.includes(normalized)
    );
  });
}

function resolveProviderName(params: {
  config: AppConfig;
  rawName: string | undefined;
}): { providerName?: string; error?: string } {
  const rawName = params.rawName?.trim();
  if (!rawName) {
    return { error: "用法：/provider <route> use <供应商名>" };
  }

  if (rawName.toLowerCase() === "default") {
    return { providerName: "" };
  }

  const profile = findProviderProfile(params.config, rawName);
  if (!profile) {
    return {
      error: `未知供应商：${rawName}\n可用：default${
        params.config.codex.providers.length > 0
          ? `, ${params.config.codex.providers.map((item) => item.name).join(", ")}`
          : ""
      }`,
    };
  }

  return { providerName: profile.name };
}

function parseProviderRoutes(values: string[]): {
  routes: CodexProviderRoute[];
  error?: string;
} {
  if (values.length === 0) {
    return { routes: [...PROVIDER_ROUTES] };
  }

  const routes = new Set<CodexProviderRoute>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "all") {
      for (const route of PROVIDER_ROUTES) routes.add(route);
      continue;
    }
    if (!isProviderRoute(normalized)) {
      return {
        routes: [],
        error: "路径只能是 admin-acp、family-api、family-acp 或 all。",
      };
    }
    routes.add(normalized);
  }

  return { routes: [...routes] };
}

function formatProviderProfile(profile: CodexProviderProfile): string {
  const parts = [
    profile.name,
    profile.displayName ?? "",
    profile.backend ? `backend=${profile.backend}` : "",
    profile.model ?? profile.apiModel ?? "",
    profile.apiBaseUrl ?? "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function buildProjectProvidersReply(config: AppConfig): string {
  return [
    "可用供应商：",
    [
      "default",
      ".env",
      config.codex.admin.apiModel,
      config.codex.admin.apiBaseUrl ?? "Codex login",
    ].join(" | "),
    ...(config.codex.providers.length > 0
      ? config.codex.providers.map(formatProviderProfile)
      : ["未配置额外 profile"]
    ),
  ].join("\n");
}

interface CcSwitchCodexProvider {
  id: string;
  name: string;
  category?: string;
  providerType?: string;
  isCurrent: boolean;
  inFailoverQueue: boolean;
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
  wireApi?: string;
}

function resolveCcSwitchDbPath(): string {
  const configured =
    process.env.CC_SWITCH_DB_PATH?.trim() ??
    process.env.CCSWITCH_DB_PATH?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".cc-switch", "cc-switch.db"));
}

function readTomlStringValue(text: string, key: string): string | undefined {
  const match = text.match(
    new RegExp(`^\\s*${key}\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')`, "m"),
  );
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].slice(1, -1);
  }
}

function parseCcSwitchProviderConfig(settingsConfig: string): {
  model?: string;
  modelProvider?: string;
  baseUrl?: string;
  wireApi?: string;
} {
  let parsed: { config?: unknown } = {};
  try {
    parsed = JSON.parse(settingsConfig) as { config?: unknown };
  } catch {
    return {};
  }

  if (typeof parsed.config !== "string") {
    return {};
  }

  const model = readTomlStringValue(parsed.config, "model");
  const modelProvider = readTomlStringValue(parsed.config, "model_provider");
  const baseUrl = readTomlStringValue(parsed.config, "base_url");
  const wireApi = readTomlStringValue(parsed.config, "wire_api");

  return {
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(wireApi ? { wireApi } : {}),
  };
}

function listCcSwitchCodexProviders(): {
  dbPath: string;
  providers: CcSwitchCodexProvider[];
  error?: string;
} {
  const dbPath = resolveCcSwitchDbPath();
  if (!fs.existsSync(dbPath)) {
    return {
      dbPath,
      providers: [],
      error: "未找到 cc-switch 数据库。",
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `
        SELECT id, app_type, name, settings_config, category,
               is_current, in_failover_queue, provider_type
        FROM providers
        WHERE app_type = 'codex'
        ORDER BY is_current DESC, sort_index IS NULL, sort_index ASC, name ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;
    const endpointStatement = db.prepare(
      `
      SELECT url
      FROM provider_endpoints
      WHERE provider_id = ? AND app_type = 'codex'
      ORDER BY id ASC
      LIMIT 1
      `,
    );

    return {
      dbPath,
      providers: rows.map((row) => {
        const config = parseCcSwitchProviderConfig(
          String(row.settings_config ?? ""),
        );
        const endpoint = endpointStatement.get(String(row.id)) as
          | { url?: string }
          | undefined;
        return {
          id: String(row.id),
          name: String(row.name),
          ...(row.category ? { category: String(row.category) } : {}),
          ...(row.provider_type
            ? { providerType: String(row.provider_type) }
            : {}),
          isCurrent: Number(row.is_current ?? 0) !== 0,
          inFailoverQueue: Number(row.in_failover_queue ?? 0) !== 0,
          ...config,
          ...(config.baseUrl
            ? {}
            : endpoint?.url
              ? { baseUrl: endpoint.url }
              : {}),
        };
      }),
    };
  } catch (error) {
    return {
      dbPath,
      providers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {

    }
  }
}

function formatCcSwitchProvider(
  provider: CcSwitchCodexProvider,
  detail = false,
): string {
  if (!detail) {
    return [
      provider.isCurrent ? "[当前]" : "",
      provider.id,
      provider.name,
      provider.model ?? "",
      provider.baseUrl ?? "",
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return [
    provider.id,
    `name=${provider.name}`,
    provider.isCurrent ? "current=yes" : "",
    provider.inFailoverQueue ? "failover=yes" : "",
    provider.category ? `category=${provider.category}` : "",
    provider.providerType ? `type=${provider.providerType}` : "",
    provider.model ? `model=${provider.model}` : "",
    provider.modelProvider ? `provider=${provider.modelProvider}` : "",
    provider.wireApi ? `wire=${provider.wireApi}` : "",
    provider.baseUrl ? `base=${provider.baseUrl}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

function buildCcSwitchProvidersReply(options?: { detail?: boolean }): string {
  const detail = options?.detail ?? false;
  const result = listCcSwitchCodexProviders();
  const lines = ["cc-switch Codex："];

  if (detail) {
    lines.push(`db=${result.dbPath}`);
  }

  if (result.error) {
    lines.push(detail ? `状态：${result.error}` : result.error);
  }

  if (result.providers.length === 0) {
    lines.push("(无)");
  } else {
    lines.push(
      ...result.providers.map((provider) =>
        formatCcSwitchProvider(provider, detail),
      ),
    );
  }

  return lines.join("\n");
}

function formatProviderRouteSettings(params: {
  config: AppConfig;
  database: AppDatabase;
  route: CodexProviderRoute;
}): string {
  const settings = params.database.getCodexProviderRouteSettings(params.route);
  const providerName = settings?.providerName ?? "";
  const providerLabel = providerName
    ? findProviderProfile(params.config, providerName)
      ? providerName
      : `${providerName}(未配置)`
    : "default";
  return [
    params.route,
    providerLabel,
    settings?.locked ? "锁定" : "未锁定",
  ].join(" | ");
}

function buildProviderStatusReply(params: {
  config: AppConfig;
  database: AppDatabase;
}): string {
  return [
    "路径：",
    ...PROVIDER_ROUTES.map((route) =>
      formatProviderRouteSettings({
        config: params.config,
        database: params.database,
        route,
      }),
    ),
    "",
    buildProjectProvidersReply(params.config),
    "",
    "用法：",
    "/provider use <供应商名>          切换所有未锁定路径",
    "/provider admin-acp use <供应商名>",
    "/provider family-api use <供应商名>",
    "/provider family-acp use <供应商名>",
    "/provider lock <路径> on|off",
    "/provider reset <路径|all>",
  ].join("\n");
}

function saveProviderForRoutes(params: {
  config: AppConfig;
  database: AppDatabase;
  providerName: string;
  routes: CodexProviderRoute[];
  respectLocks: boolean;
  onChanged?: (routes: CodexProviderRoute[]) => void;
}): string {
  const changed = params.routes.filter((route) => {
    const settings = params.database.getCodexProviderRouteSettings(route);
    return !(params.respectLocks && settings?.locked);
  });
  const skippedLocked: CodexProviderRoute[] = [];
  for (const route of params.routes) {
    const settings = params.database.getCodexProviderRouteSettings(route);
    if (params.respectLocks && settings?.locked) {
      skippedLocked.push(route);
    }
  }

  for (const route of changed) {
    const role: UserRole = route === "admin-acp" ? "admin" : "family";
    const effective = resolveEffectiveCodexRouteSettings({
      config: params.config,
      database: params.database,
      role,
      route,
      providerNameOverride: params.providerName,
    });
    if (
      isCodexReasoningEffort(effective.reasoning) &&
      !isCodexModelReasoningEffortSupported(
        effective.model,
        effective.reasoning,
      )
    ) {
      return [
        `不能切换 ${route}：模型 ${effective.model} 不支持思考强度 ${effective.reasoning}。`,
        ...(getCodexModelReasoningEfforts(effective.model)
          ? [
              `该模型可选：${formatChoices(
                getCodexModelReasoningEfforts(effective.model)!,
              )}`,
            ]
          : []),
        "请先用 /codex 调整模型或思考强度。",
      ].join("\n");
    }
  }

  for (const route of changed) {
    params.database.saveCodexProviderRouteSettings({
      route,
      providerName: params.providerName,
    });
  }

  if (changed.length > 0) {
    params.onChanged?.(changed);
  }

  const providerLabel = params.providerName || "default";
  return [
    changed.length > 0
      ? `已切换：${changed.join(", ")} -> ${providerLabel}`
      : "没有路径被切换。",
    skippedLocked.length > 0
      ? `已跳过锁定路径：${skippedLocked.join(", ")}`
      : "",
    changed.length > 0 ? "已刷新对应后端；后续新请求会使用新供应商。" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function saveProviderLocks(params: {
  database: AppDatabase;
  routes: CodexProviderRoute[];
  locked: boolean;
}): string {
  for (const route of params.routes) {
    params.database.saveCodexProviderRouteSettings({
      route,
      locked: params.locked,
    });
  }

  return `已${params.locked ? "锁定" : "解锁"}：${params.routes.join(", ")}。`;
}

function buildProviderSettingsReply(params: {
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  command: ParsedCommand;
  onChanged?: (routes: CodexProviderRoute[]) => void;
}): string {
  if (params.role !== "admin") {
    return "这个供应商命令只对 admin 开放。";
  }

  const [firstRaw, secondRaw, thirdRaw, ...restRaw] = params.command.args;
  const first = firstRaw?.trim().toLowerCase();
  const second = secondRaw?.trim().toLowerCase();
  const third = thirdRaw?.trim().toLowerCase();

  if (!first || first === "status") {
    return buildProviderStatusReply(params);
  }

  if (first === "list") {
    return buildProjectProvidersReply(params.config);
  }

  if (first === "ccswitch" || first === "cc-switch") {
    return buildCcSwitchProvidersReply({ detail: second === "detail" });
  }

  if (first === "use") {
    const resolved = resolveProviderName({
      config: params.config,
      rawName: secondRaw,
    });
    if (resolved.error) return resolved.error;
    const parsedRoutes = parseProviderRoutes([thirdRaw, ...restRaw].filter(
      (item): item is string => Boolean(item),
    ));
    if (parsedRoutes.error) return parsedRoutes.error;
    return saveProviderForRoutes({
      config: params.config,
      database: params.database,
      providerName: resolved.providerName ?? "",
      routes: parsedRoutes.routes,
      respectLocks: true,
      ...(params.onChanged ? { onChanged: params.onChanged } : {}),
    });
  }

  if (first === "reset") {
    const parsedRoutes = parseProviderRoutes([secondRaw, thirdRaw, ...restRaw].filter(
      (item): item is string => Boolean(item),
    ));
    if (parsedRoutes.error) return parsedRoutes.error;
    return saveProviderForRoutes({
      config: params.config,
      database: params.database,
      providerName: "",
      routes: parsedRoutes.routes,
      respectLocks: true,
      ...(params.onChanged ? { onChanged: params.onChanged } : {}),
    });
  }

  if (first === "lock") {
    const parsedRoutes = parseProviderRoutes(secondRaw ? [secondRaw] : []);
    if (parsedRoutes.error) return parsedRoutes.error;
    const enabled = parseSwitch(third);
    if (enabled === undefined) {
      return "用法：/provider lock admin-acp|family-api|family-acp|all on|off";
    }
    return saveProviderLocks({
      database: params.database,
      routes: parsedRoutes.routes,
      locked: enabled,
    });
  }

  if (isProviderRoute(first)) {
    const route = first;
    if (!second) {
      return formatProviderRouteSettings({
        config: params.config,
        database: params.database,
        route,
      });
    }

    if (second === "use") {
      const resolved = resolveProviderName({
        config: params.config,
        rawName: thirdRaw,
      });
      if (resolved.error) return resolved.error;
      return saveProviderForRoutes({
        config: params.config,
        database: params.database,
        providerName: resolved.providerName ?? "",
        routes: [route],
        respectLocks: false,
        ...(params.onChanged ? { onChanged: params.onChanged } : {}),
      });
    }

    if (second === "reset") {
      return saveProviderForRoutes({
        config: params.config,
        database: params.database,
        providerName: "",
        routes: [route],
        respectLocks: false,
        ...(params.onChanged ? { onChanged: params.onChanged } : {}),
      });
    }

    if (second === "lock") {
      const enabled = parseSwitch(third);
      if (enabled === undefined) {
        return "用法：/provider <路径> lock on|off";
      }
      return saveProviderLocks({
        database: params.database,
        routes: [route],
        locked: enabled,
      });
    }
  }

  return "用法：/provider [list|use <供应商>|<路径> use <供应商>|lock <路径> on|off|reset <路径|all>]";
}

function formatSwitch(value: boolean): string {
  return value ? "on" : "off";
}

function parseSwitch(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["on", "true", "1", "开", "开启", "打开"].includes(normalized)) {
    return true;
  }

  if (["off", "false", "0", "关", "关闭"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function resolveProgressDefault(params: {
  config: AppConfig;
  role: UserRole;
}): boolean {
  return params.role === "admin"
    ? params.config.wechat.adminProgressEnabled
    : params.config.wechat.familyProgressEnabled;
}

function buildOutputSettingsReply(params: {
  command: ParsedCommand;
  config: AppConfig;
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
  sessionMemory: SessionMemoryState;
}): string {
  const progressEnabled =
    params.sessionMemory.outputProgressEnabled ??
    resolveProgressDefault({
      config: params.config,
      role: params.role,
    });
  const familyApiStreamingEnabled =
    params.sessionMemory.familyApiStreamingEnabled ??
    params.config.wechat.familyApiStreamingEnabled;

  const target = params.command.args[0]?.trim().toLowerCase();
  if (!target) {
    const lines = [
      "当前输出设置：",
      `process=${formatSwitch(progressEnabled)}`,
    ];
    if (params.role === "family") {
      lines.push(`family-api-stream=${formatSwitch(familyApiStreamingEnabled)}`);
    }
    lines.push(
      "",
      "用法：",
      "/output process on|off",
      params.role === "family" ? "/output family-api-stream on|off" : "",
    );
    return lines.filter((line) => line !== "").join("\n");
  }

  if (target !== "process" && target !== "family-api-stream") {
    return "用法：/output process on|off 或 /output family-api-stream on|off";
  }

  if (target === "family-api-stream" && params.role !== "family") {
    return "family-api-stream 只影响 family 的直连 API 早发。";
  }

  const enabled = parseSwitch(params.command.args[1]);
  if (enabled === undefined) {
    return "用法：/output process on|off 或 /output family-api-stream on|off";
  }

  const nextMemory =
    target === "process"
      ? {
          ...params.sessionMemory,
          outputProgressEnabled: enabled,
        }
      : {
          ...params.sessionMemory,
          familyApiStreamingEnabled: enabled,
        };
  params.database.saveSession({
    id: params.session.id,
    wechatAccountId: params.session.wechatAccountId,
    contactId: params.session.contactId,
    role: params.session.role,
    status: params.session.status,
    summaryText: params.session.summaryText,
    memoryJson: stringifySessionMemory(nextMemory),
    contextToken: params.session.contextToken,
    lastActiveAt: params.session.lastActiveAt,
  });

  return target === "process"
    ? `过程输出已${enabled ? "开启" : "关闭"}。`
    : `family API 早发已${enabled ? "开启" : "关闭"}。`;
}

function buildSessionsReply(params: {
  database: AppDatabase;
  role: UserRole;
  session: SessionRecord;
}): string {
  if (params.role !== "admin") {
    return [
      "当前对话：",
      `session=${params.session.id}`,
      `last=${params.session.lastActiveAt}`,
    ].join("\n");
  }

  const sessions = params.database.listRecentSessions(10);
  if (sessions.length === 0) return "当前还没有会话。";

  return [
    "最近会话：",
    ...sessions.map((session) =>
      [
        `session=${session.id}`,
        `role=${session.role}`,
        `account=${session.wechatAccountId}`,
        `contact=${session.contactId}`,
        `last=${session.lastActiveAt}`,
        `summary=${session.summaryText.trim() ? "yes" : "no"}`,
      ].join("  "),
    ),
  ].join("\n");
}

function buildFilesReply(params: {
  config: AppConfig;
  role: UserRole;
  session?: SessionRecord;
}): string {
  if (params.role === "family") {
    if (!params.session) return "当前会话还没有可回传的成品文件。";
    const { outboxDir } = buildSessionWorkspacePaths({
      config: params.config,
      sessionId: params.session.id,
    });
    const files = fs.existsSync(outboxDir) ? listFilesForReply(outboxDir, 2) : [];
    if (files.length === 0) {
      return `当前会话 outbox 里还没有可回传的成品文件。\noutbox：${outboxDir}`;
    }
    return ["当前会话可回传文件：", ...files.slice(0, 10)].join("\n");
  }

  if (params.role !== "admin") return "这个文件命令暂时不可用。";

  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  for (const directory of params.config.fileSend.allowedDirs) {
    if (!fs.existsSync(directory)) continue;
    for (const filePath of listFilesForReply(directory, 2)) {
      const stat = fs.statSync(filePath);
      if (stat.size > params.config.fileSend.maxBytes) continue;
      files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const recent = files.slice(0, 10);
  if (recent.length === 0) {
    return `白名单目录里暂时没有可发送文件。\n允许目录：${params.config.fileSend.allowedDirs.join(", ")}`;
  }

  return [
    "最近可发送文件：",
    ...recent.map((file) => `${file.filePath}  ${formatBytes(file.size)}`),
  ].join("\n");
}

export function buildCommandReply(params: {
  command: ParsedCommand;
  session: SessionRecord;
  database: AppDatabase;
  role: UserRole;
  accountRole: UserRole;
  sessionMemory: SessionMemoryState;
  account: WechatAccountRecord;
  config: AppConfig;
  onRoleModeChanged?: (nextRole: UserRole) => void;
  onCodexSettingsChanged?: (role: UserRole) => void;
  onProviderSettingsChanged?: (routes: CodexProviderRoute[]) => void;
}): string {
  switch (params.command.name) {
    case "/time":
      return `现在是北京时间 ${formatBeijingTime(new Date())}。`;
    case "/stop":
    case "/cancel":
      return "当前没有正在处理的任务。";
    case "/help":
      return params.role === "admin"
        ? [
            "可用命令：",
            "/time 查看北京时间",
            "/stop 停止当前正在执行的任务",
            "/whoami 查看当前账号角色",
            "/mode 查看或切换当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/sessions 查看最近会话",
            "/recent 查看最近几条消息",
            "/summary 查看当前摘要",
            "/new 开启新话题，/reset /clear 彻底清空当前对话",
            "/file <文件路径> [说明] 发送允许目录里的服务器文件",
            "/files 查看最近可发送文件",
            "/accounts 查看已绑定微信账号",
            "/codex 查看或修改 admin/family 的模型与思考强度",
            "/provider 查看或切换供应商路径",
            "/output 查看或切换过程输出",
          ].join("\n")
        : [
            "可用命令：",
            "/time 查看北京时间",
            "/stop 停止当前正在执行的任务",
            "/whoami 查看当前账号角色",
            "/mode 查看当前会话模式",
            "/memory 查看当前会话 memory",
            "/last 查看上一段对话",
            "/yesterday 查看昨天的上一段对话",
            "/new 开启新话题，/reset /clear 彻底清空当前对话",
            "/file <outbox文件路径> [说明] 回传当前会话产出的成品文件",
            "/output 查看或切换过程输出",
          ].join("\n");
    case "/whoami":
      return [
        `角色：${params.role}`,
        `账号默认角色：${params.accountRole}`,
        `当前模式：${params.sessionMemory.routeMode ?? params.role}`,
        `账号：${params.account.id}`,
        `会话：${params.session.id}`,
      ].join("\n");
    case "/mode": {
      const requested = params.command.args[0]?.trim().toLowerCase();
      const currentMode = params.sessionMemory.routeMode ?? params.role;
      if (!requested) {
        return [
          `当前模式：${currentMode}`,
          params.accountRole === "admin"
            ? "可用：/mode admin 或 /mode family"
            : "普通 family 账号不能切到 admin。",
        ].join("\n");
      }
      if (requested !== "admin" && requested !== "family") {
        return "用法：/mode admin 或 /mode family";
      }
      if (requested === "admin" && params.accountRole !== "admin") {
        return "普通 family 账号不能切到 admin。";
      }
      const nextRole = requested as UserRole;
      const nextMemory = stringifySessionMemory({
        ...params.sessionMemory,
        routeMode: nextRole,
      });
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: nextRole,
        status: params.session.status,
        summaryText: params.session.summaryText,
        memoryJson: nextMemory,
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      params.onRoleModeChanged?.(nextRole);
      return nextRole === "admin"
        ? "当前会话已切到 admin 模式。"
        : "当前会话已切到 family 模式。";
    }
    case "/sessions":
      return buildSessionsReply(params);
    case "/accounts":
      return buildAccountsReply(params);
    case "/codex":
      return buildCodexSettingsReply({
        config: params.config,
        database: params.database,
        role: params.role,
        command: params.command,
        ...(params.onCodexSettingsChanged
          ? { onChanged: params.onCodexSettingsChanged }
          : {}),
      });
    case "/provider":
      return buildProviderSettingsReply({
        config: params.config,
        database: params.database,
        role: params.role,
        command: params.command,
        ...(params.onProviderSettingsChanged
          ? { onChanged: params.onProviderSettingsChanged }
          : {}),
      });
    case "/output":
      return buildOutputSettingsReply({
        command: params.command,
        config: params.config,
        database: params.database,
        role: params.role,
        session: params.session,
        sessionMemory: params.sessionMemory,
      });
    case "/files":
      return buildFilesReply({
        config: params.config,
        role: params.role,
        session: params.session,
      });
    case "/summary":
      return params.session.summaryText.trim()
        ? `当前摘要：${params.session.summaryText}`
        : "当前还没有保存摘要。";
    case "/memory": {
      const parts = [
        `turn_count=${params.sessionMemory.turnCount ?? 0}`,
        `estimated_tokens=${params.sessionMemory.estimatedTokenCount ?? 0}`,
      ];
      if (params.sessionMemory.carryoverSourceSessionId) {
        parts.push(`carryover_session=${params.sessionMemory.carryoverSourceSessionId}`);
      }
      if (params.sessionMemory.carryoverSourceLastActiveAt) {
        parts.push(`carryover_last=${params.sessionMemory.carryoverSourceLastActiveAt}`);
      }
      if (params.sessionMemory.carryoverSummary?.trim()) {
        parts.push(`carryover_summary=${params.sessionMemory.carryoverSummary}`);
      }
      if (params.sessionMemory.familyApiContext?.trim()) {
        parts.push(`family_api_context_chars=${params.sessionMemory.familyApiContext.length}`);
      }
      if (params.sessionMemory.lastAcpTaskNote?.trim()) {
        parts.push(`last_acp_task_note_chars=${params.sessionMemory.lastAcpTaskNote.length}`);
      }
      if (params.sessionMemory.lastFamilyBackend) {
        parts.push(`last_family_backend=${params.sessionMemory.lastFamilyBackend}`);
      }
      if (params.sessionMemory.lastFamilyBackendReason) {
        parts.push(`last_family_backend_reason=${params.sessionMemory.lastFamilyBackendReason}`);
      }
      return `当前 memory：\n${parts.join("\n")}`;
    }
    case "/last": {
      const previous = findPreviousSession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `上一段对话：\n${formatSessionSnapshot({ session: previous, database: params.database })}`
        : "当前还没有上一段对话。";
    }
    case "/yesterday": {
      const previous = findYesterdaySession({
        database: params.database,
        session: params.session,
      });
      return previous
        ? `昨天的上一段对话：\n${formatSessionSnapshot({ session: previous, database: params.database })}`
        : "当前还没有可用的昨天对话。";
    }
    case "/recent": {
      const recent = params.database
        .listSessionMessages(params.session.id, 6)
        .reverse()
        .map((message) => {
          const speaker = message.direction === "inbound" ? "用户" : "助手";
          const text = message.textContent?.trim() || "[非文本消息]";
          return `${speaker}：${text}`;
        });
      return recent.length > 0
        ? `最近消息：\n${recent.join("\n")}`
        : "当前会话里还没有最近消息。";
    }
    case "/new":
    case "/reset":
    case "/clear": {
      const isHardClear = params.command.name !== "/new" || params.role !== "family";
      const recentMessagesForCarryover = params.database
        .listSessionMessages(params.session.id, 12)
        .reverse();
      const archivedSummary =
        buildDeterministicSessionSummary({
          session: params.session,
          recentMessages: recentMessagesForCarryover,
        }) || params.session.summaryText;
      const carryoverSummary = isHardClear
        ? ""
        : summarizeCarryoverContext({
            session: params.session,
            recentMessages: recentMessagesForCarryover,
          });
      params.database.saveSession({
        id: params.session.id,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.session.role,
        status: "archived",
        summaryText: archivedSummary,
        memoryJson: params.session.memoryJson,
        contextToken: params.session.contextToken,
        lastActiveAt: params.session.lastActiveAt,
      });
      const nextSessionId = buildSessionId(
        params.session.wechatAccountId,
        params.session.contactId,
        crypto.randomUUID(),
      );
      params.database.saveSession({
        id: nextSessionId,
        wechatAccountId: params.session.wechatAccountId,
        contactId: params.session.contactId,
        role: params.accountRole,
        status: "active",
        summaryText: isHardClear ? "" : archivedSummary,
        memoryJson: stringifySessionMemory({
          ...(params.sessionMemory.routeMode && !isHardClear
            ? { routeMode: params.sessionMemory.routeMode }
            : {}),
          ...(carryoverSummary
            ? {
                carryoverSummary,
                carryoverSourceSessionId: params.session.id,
                carryoverSourceLastActiveAt: params.session.lastActiveAt,
              }
            : {}),
        }),
        contextToken: params.session.contextToken,
        lastActiveAt: new Date().toISOString(),
      });
      return isHardClear
        ? "当前对话已经彻底清空，并且已经切到一个新的会话。我们可以重新开始。"
        : "已经开启新话题；我会保留一点上一段的轻量上下文，避免突然断片。要彻底清空请发 /reset 或 /clear。";
    }
    default:
      return "暂不支持这个内建命令。";
  }
}
