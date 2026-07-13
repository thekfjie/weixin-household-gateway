import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexProviderRoute, UserRole } from "../config/types.js";
import { SQLITE_SCHEMA } from "./schema.js";
import {
  AttachmentRecord,
  CodexProviderRouteSettingsRecord,
  CodexRoleSettingsRecord,
  MessageRecord,
  SessionRecord,
  WechatAccountRecord,
} from "./types.js";

const CODEX_PROVIDER_ROUTES: readonly CodexProviderRoute[] = [
  "admin-acp",
  "family-api",
  "family-acp",
];

function ensureParentDir(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

function createNow(): string {
  return new Date().toISOString();
}

function toAccountRecord(row: Record<string, unknown>): WechatAccountRecord {
  return {
    id: String(row.id),
    ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    role: String(row.role) as UserRole,
    authToken: String(row.auth_token),
    uin: String(row.uin),
    ...(row.base_url ? { baseUrl: String(row.base_url) } : {}),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    wechatAccountId: String(row.wechat_account_id),
    contactId: String(row.contact_id),
    role: String(row.role) as UserRole,
    status: String(row.status),
    summaryText: String(row.summary_text),
    memoryJson: String(row.memory_json),
    contextToken: String(row.context_token ?? ""),
    lastActiveAt: String(row.last_active_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAttachmentRecord(row: Record<string, unknown>): AttachmentRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    localPath: String(row.local_path),
    mimeType: String(row.mime_type),
    fileName: String(row.file_name),
    sizeBytes: Number(row.size_bytes),
    outboundStatus: String(row.outbound_status),
    createdAt: String(row.created_at),
  };
}

function toCodexRoleSettingsRecord(
  row: Record<string, unknown>,
): CodexRoleSettingsRecord {
  return {
    role: String(row.role) as UserRole,
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: String(row.reasoning_effort) }
      : {}),
    updatedAt: String(row.updated_at),
  };
}

function toCodexProviderRouteSettingsRecord(
  row: Record<string, unknown>,
): CodexProviderRouteSettingsRecord {
  return {
    route: String(row.route) as CodexProviderRoute,
    ...(row.provider_name ? { providerName: String(row.provider_name) } : {}),
    locked: Number(row.locked ?? 0) !== 0,
    updatedAt: String(row.updated_at),
  };
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(private readonly filePath: string) {
    ensureParentDir(filePath);
    this.db = new DatabaseSync(filePath);
  }

  initialize(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SQLITE_SCHEMA);
    this.ensureLegacyColumns();
  }

  close(): void {
    this.db.close();
  }

  getFilePath(): string {
    return this.filePath;
  }

  private ensureLegacyColumns(): void {
    this.ensureColumn("wechat_accounts", "base_url", "TEXT");
    this.ensureColumn(
      "sessions",
      "context_token",
      "TEXT NOT NULL DEFAULT ''",
    );
  }

  private ensureColumn(
    tableName: string,
    columnName: string,
    columnDefinition: string,
  ): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    const exists = rows.some((row) => row.name === columnName);
    if (exists) {
      return;
    }

    this.db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`,
    );
  }

  listAccounts(): WechatAccountRecord[] {
    const statement = this.db.prepare(
      "SELECT * FROM wechat_accounts ORDER BY created_at ASC",
    );
    const rows = statement.all() as Record<string, unknown>[];
    return rows.map(toAccountRecord);
  }

  getAccountById(accountId: string): WechatAccountRecord | undefined {
    const statement = this.db.prepare(
      "SELECT * FROM wechat_accounts WHERE id = ?",
    );
    const row = statement.get(accountId) as Record<string, unknown> | undefined;
    return row ? toAccountRecord(row) : undefined;
  }

  saveAccount(input: {
    id: string;
    displayName?: string;
    role: UserRole;
    authToken: string;
    uin: string;
    baseUrl?: string;
    status?: string;
  }): WechatAccountRecord {
    const now = createNow();
    const existing = this.getAccountById(input.id);

    this.db
      .prepare(
        `
        INSERT INTO wechat_accounts (
          id, display_name, role, auth_token, uin, base_url, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          role = excluded.role,
          auth_token = excluded.auth_token,
          uin = excluded.uin,
          base_url = excluded.base_url,
          status = excluded.status,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.displayName ?? null,
        input.role,
        input.authToken,
        input.uin,
        input.baseUrl ?? null,
        input.status ?? "active",
        existing?.createdAt ?? now,
        now,
      );

    const saved = this.getAccountById(input.id);
    if (!saved) {
      throw new Error(`Failed to save account ${input.id}`);
    }

    return saved;
  }

  updateAccountRole(accountId: string, role: UserRole): WechatAccountRecord {
    const existing = this.getAccountById(accountId);
    if (!existing) {
      throw new Error(`Account not found: ${accountId}`);
    }

    this.db
      .prepare(
        `
        UPDATE wechat_accounts
        SET role = ?, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(role, createNow(), accountId);

    const updated = this.getAccountById(accountId);
    if (!updated) {
      throw new Error(`Failed to update account role: ${accountId}`);
    }

    return updated;
  }

  updateAccountStatus(accountId: string, status: string): WechatAccountRecord {
    const existing = this.getAccountById(accountId);
    if (!existing) {
      throw new Error(`Account not found: ${accountId}`);
    }

    this.db
      .prepare(
        `
        UPDATE wechat_accounts
        SET status = ?, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(status, createNow(), accountId);

    const updated = this.getAccountById(accountId);
    if (!updated) {
      throw new Error(`Failed to update account status: ${accountId}`);
    }

    return updated;
  }

  getCodexRoleSettings(role: UserRole): CodexRoleSettingsRecord | undefined {
    const statement = this.db.prepare(
      "SELECT * FROM codex_role_settings WHERE role = ?",
    );
    const row = statement.get(role) as Record<string, unknown> | undefined;
    return row ? toCodexRoleSettingsRecord(row) : undefined;
  }

  saveCodexRoleSettings(input: {
    role: UserRole;
    model?: string;
    reasoningEffort?: string;
  }): CodexRoleSettingsRecord {
    const now = createNow();
    this.db
      .prepare(
        `
        INSERT INTO codex_role_settings (
          role, model, reasoning_effort, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        input.role,
        input.model ?? null,
        input.reasoningEffort ?? null,
        now,
      );

    const saved = this.getCodexRoleSettings(input.role);
    if (!saved) {
      throw new Error(`Failed to save codex role settings: ${input.role}`);
    }

    return saved;
  }

  listCodexProviderRouteSettings(): CodexProviderRouteSettingsRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM codex_provider_routes ORDER BY route ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toCodexProviderRouteSettingsRecord);
  }

  getCodexProviderRouteSettings(
    route: CodexProviderRoute,
  ): CodexProviderRouteSettingsRecord | undefined {
    const statement = this.db.prepare(
      "SELECT * FROM codex_provider_routes WHERE route = ?",
    );
    const row = statement.get(route) as Record<string, unknown> | undefined;
    return row ? toCodexProviderRouteSettingsRecord(row) : undefined;
  }

  saveCodexProviderRouteSettings(input: {
    route: CodexProviderRoute;
    providerName?: string;
    locked?: boolean;
  }): CodexProviderRouteSettingsRecord {
    if (!CODEX_PROVIDER_ROUTES.includes(input.route)) {
      throw new Error(`Invalid provider route: ${input.route}`);
    }

    const now = createNow();
    const existing = this.getCodexProviderRouteSettings(input.route);
    const providerName =
      input.providerName !== undefined
        ? input.providerName.trim()
        : existing?.providerName;
    const locked = input.locked ?? existing?.locked ?? false;
    this.db
      .prepare(
        `
        INSERT INTO codex_provider_routes (
          route, provider_name, locked, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(route) DO UPDATE SET
          provider_name = excluded.provider_name,
          locked = excluded.locked,
          updated_at = excluded.updated_at
        `,
      )
      .run(input.route, providerName || null, locked ? 1 : 0, now);

    const saved = this.getCodexProviderRouteSettings(input.route);
    if (!saved) {
      throw new Error(`Failed to save codex provider route: ${input.route}`);
    }

    return saved;
  }

  getPollingCursor(accountId: string): string | undefined {
    const statement = this.db.prepare(
      "SELECT cursor FROM polling_state WHERE wechat_account_id = ?",
    );
    const row = statement.get(accountId) as { cursor?: string } | undefined;
    return row?.cursor;
  }

  savePollingCursor(accountId: string, cursor: string): void {
    this.db
      .prepare(
        `
        INSERT INTO polling_state (wechat_account_id, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(wechat_account_id) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
        `,
      )
      .run(accountId, cursor, createNow());
  }

  getSessionByPeer(
    wechatAccountId: string,
    contactId: string,
  ): SessionRecord | undefined {
    const statement = this.db.prepare(
      `
      SELECT * FROM sessions
      WHERE wechat_account_id = ? AND contact_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
      `,
    );
    const row = statement.get(
      wechatAccountId,
      contactId,
    ) as Record<string, unknown> | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  getSessionById(sessionId: string): SessionRecord | undefined {
    const statement = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
    const row = statement.get(sessionId) as Record<string, unknown> | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  listRecentSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM sessions
        WHERE status = 'active'
        ORDER BY last_active_at DESC
        LIMIT ?
        `,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(toSessionRecord);
  }

  listSessionsByPeer(
    wechatAccountId: string,
    contactId: string,
    limit = 20,
  ): SessionRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM sessions
        WHERE wechat_account_id = ? AND contact_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
        `,
      )
      .all(
        wechatAccountId,
        contactId,
        limit,
      ) as Array<Record<string, unknown>>;

    return rows.map(toSessionRecord);
  }

  saveSession(input: {
    id: string;
    wechatAccountId: string;
    contactId: string;
    role: UserRole;
    status?: string;
    summaryText?: string;
    memoryJson?: string;
    contextToken?: string;
    lastActiveAt?: string;
  }): SessionRecord {
    const now = createNow();
    const existing = this.db
      .prepare("SELECT created_at FROM sessions WHERE id = ?")
      .get(input.id) as { created_at?: string } | undefined;

    this.db
      .prepare(
        `
        INSERT INTO sessions (
          id, wechat_account_id, contact_id, role, status, summary_text,
          memory_json, context_token, last_active_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          status = excluded.status,
          summary_text = excluded.summary_text,
          memory_json = excluded.memory_json,
          context_token = excluded.context_token,
          last_active_at = excluded.last_active_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.wechatAccountId,
        input.contactId,
        input.role,
        input.status ?? "active",
        input.summaryText ?? "",
        input.memoryJson ?? "{}",
        input.contextToken ?? "",
        input.lastActiveAt ?? now,
        existing?.created_at ?? now,
        now,
      );

    const saved = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(input.id) as Record<string, unknown> | undefined;
    if (!saved) {
      throw new Error(`Failed to save session ${input.id}`);
    }

    return toSessionRecord(saved);
  }

  appendMessage(input: MessageRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO messages (
          id, session_id, direction, message_type, text_content,
          file_path, created_at, source_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.sessionId,
        input.direction,
        input.messageType,
        input.textContent ?? null,
        input.filePath ?? null,
        input.createdAt,
        input.sourceMessageId ?? null,
      );
  }

  listSessionMessages(sessionId: string, limit = 10): MessageRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      direction: String(row.direction) as "inbound" | "outbound",
      messageType: String(row.message_type),
      ...(row.text_content ? { textContent: String(row.text_content) } : {}),
      ...(row.file_path ? { filePath: String(row.file_path) } : {}),
      createdAt: String(row.created_at),
      ...(row.source_message_id
        ? { sourceMessageId: String(row.source_message_id) }
        : {}),
    }));
  }

  saveAttachment(input: {
    id: string;
    sessionId: string;
    localPath: string;
    mimeType: string;
    fileName: string;
    sizeBytes: number;
    outboundStatus: string;
    createdAt?: string;
  }): AttachmentRecord {
    const createdAt = input.createdAt ?? createNow();

    this.db
      .prepare(
        `
        INSERT INTO attachments (
          id, session_id, local_path, mime_type, file_name,
          size_bytes, outbound_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          local_path = excluded.local_path,
          mime_type = excluded.mime_type,
          file_name = excluded.file_name,
          size_bytes = excluded.size_bytes,
          outbound_status = excluded.outbound_status
        `,
      )
      .run(
        input.id,
        input.sessionId,
        input.localPath,
        input.mimeType,
        input.fileName,
        input.sizeBytes,
        input.outboundStatus,
        createdAt,
      );

    const saved = this.getAttachmentById(input.id);
    if (!saved) {
      throw new Error(`Failed to save attachment ${input.id}`);
    }

    return saved;
  }

  getAttachmentById(attachmentId: string): AttachmentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(attachmentId) as Record<string, unknown> | undefined;
    return row ? toAttachmentRecord(row) : undefined;
  }

  updateAttachmentStatus(
    attachmentId: string,
    outboundStatus: string,
  ): AttachmentRecord {
    this.db
      .prepare(
        `
        UPDATE attachments
        SET outbound_status = ?
        WHERE id = ?
        `,
      )
      .run(outboundStatus, attachmentId);

    const updated = this.getAttachmentById(attachmentId);
    if (!updated) {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }

    return updated;
  }
}
