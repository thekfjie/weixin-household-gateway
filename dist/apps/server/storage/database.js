"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppDatabase = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_sqlite_1 = require("node:sqlite");
const schema_js_1 = require("./schema.js");
function ensureParentDir(target) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
}
function createNow() {
    return new Date().toISOString();
}
function toAccountRecord(row) {
    return {
        id: String(row.id),
        ...(row.display_name ? { displayName: String(row.display_name) } : {}),
        role: String(row.role),
        authToken: String(row.auth_token),
        uin: String(row.uin),
        ...(row.base_url ? { baseUrl: String(row.base_url) } : {}),
        status: String(row.status),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
function toSessionRecord(row) {
    return {
        id: String(row.id),
        wechatAccountId: String(row.wechat_account_id),
        contactId: String(row.contact_id),
        role: String(row.role),
        status: String(row.status),
        summaryText: String(row.summary_text),
        memoryJson: String(row.memory_json),
        contextToken: String(row.context_token ?? ""),
        lastActiveAt: String(row.last_active_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
function toAttachmentRecord(row) {
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
function toCodexRoleSettingsRecord(row) {
    return {
        role: String(row.role),
        ...(row.model ? { model: String(row.model) } : {}),
        ...(row.reasoning_effort
            ? { reasoningEffort: String(row.reasoning_effort) }
            : {}),
        updatedAt: String(row.updated_at),
    };
}
class AppDatabase {
    filePath;
    db;
    constructor(filePath) {
        this.filePath = filePath;
        ensureParentDir(filePath);
        this.db = new node_sqlite_1.DatabaseSync(filePath);
    }
    initialize() {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.db.exec(schema_js_1.SQLITE_SCHEMA);
        this.ensureLegacyColumns();
    }
    close() {
        this.db.close();
    }
    getFilePath() {
        return this.filePath;
    }
    ensureLegacyColumns() {
        this.ensureColumn("wechat_accounts", "base_url", "TEXT");
        this.ensureColumn("sessions", "context_token", "TEXT NOT NULL DEFAULT ''");
    }
    ensureColumn(tableName, columnName, columnDefinition) {
        const rows = this.db
            .prepare(`PRAGMA table_info(${tableName})`)
            .all();
        const exists = rows.some((row) => row.name === columnName);
        if (exists) {
            return;
        }
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
    }
    listAccounts() {
        const statement = this.db.prepare("SELECT * FROM wechat_accounts ORDER BY created_at ASC");
        const rows = statement.all();
        return rows.map(toAccountRecord);
    }
    getAccountById(accountId) {
        const statement = this.db.prepare("SELECT * FROM wechat_accounts WHERE id = ?");
        const row = statement.get(accountId);
        return row ? toAccountRecord(row) : undefined;
    }
    saveAccount(input) {
        const now = createNow();
        const existing = this.getAccountById(input.id);
        this.db
            .prepare(`
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
        `)
            .run(input.id, input.displayName ?? null, input.role, input.authToken, input.uin, input.baseUrl ?? null, input.status ?? "active", existing?.createdAt ?? now, now);
        const saved = this.getAccountById(input.id);
        if (!saved) {
            throw new Error(`Failed to save account ${input.id}`);
        }
        return saved;
    }
    updateAccountRole(accountId, role) {
        const existing = this.getAccountById(accountId);
        if (!existing) {
            throw new Error(`Account not found: ${accountId}`);
        }
        this.db
            .prepare(`
        UPDATE wechat_accounts
        SET role = ?, updated_at = ?
        WHERE id = ?
        `)
            .run(role, createNow(), accountId);
        const updated = this.getAccountById(accountId);
        if (!updated) {
            throw new Error(`Failed to update account role: ${accountId}`);
        }
        return updated;
    }
    updateAccountStatus(accountId, status) {
        const existing = this.getAccountById(accountId);
        if (!existing) {
            throw new Error(`Account not found: ${accountId}`);
        }
        this.db
            .prepare(`
        UPDATE wechat_accounts
        SET status = ?, updated_at = ?
        WHERE id = ?
        `)
            .run(status, createNow(), accountId);
        const updated = this.getAccountById(accountId);
        if (!updated) {
            throw new Error(`Failed to update account status: ${accountId}`);
        }
        return updated;
    }
    getCodexRoleSettings(role) {
        const statement = this.db.prepare("SELECT * FROM codex_role_settings WHERE role = ?");
        const row = statement.get(role);
        return row ? toCodexRoleSettingsRecord(row) : undefined;
    }
    saveCodexRoleSettings(input) {
        const now = createNow();
        this.db
            .prepare(`
        INSERT INTO codex_role_settings (
          role, model, reasoning_effort, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          updated_at = excluded.updated_at
        `)
            .run(input.role, input.model ?? null, input.reasoningEffort ?? null, now);
        const saved = this.getCodexRoleSettings(input.role);
        if (!saved) {
            throw new Error(`Failed to save codex role settings: ${input.role}`);
        }
        return saved;
    }
    getPollingCursor(accountId) {
        const statement = this.db.prepare("SELECT cursor FROM polling_state WHERE wechat_account_id = ?");
        const row = statement.get(accountId);
        return row?.cursor;
    }
    savePollingCursor(accountId, cursor) {
        this.db
            .prepare(`
        INSERT INTO polling_state (wechat_account_id, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(wechat_account_id) DO UPDATE SET
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
        `)
            .run(accountId, cursor, createNow());
    }
    getSessionByPeer(wechatAccountId, contactId) {
        const statement = this.db.prepare(`
      SELECT * FROM sessions
      WHERE wechat_account_id = ? AND contact_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
      `);
        const row = statement.get(wechatAccountId, contactId);
        return row ? toSessionRecord(row) : undefined;
    }
    getSessionById(sessionId) {
        const statement = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
        const row = statement.get(sessionId);
        return row ? toSessionRecord(row) : undefined;
    }
    listRecentSessions(limit = 20) {
        const rows = this.db
            .prepare(`
        SELECT * FROM sessions
        WHERE status = 'active'
        ORDER BY last_active_at DESC
        LIMIT ?
        `)
            .all(limit);
        return rows.map(toSessionRecord);
    }
    listSessionsByPeer(wechatAccountId, contactId, limit = 20) {
        const rows = this.db
            .prepare(`
        SELECT * FROM sessions
        WHERE wechat_account_id = ? AND contact_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
        `)
            .all(wechatAccountId, contactId, limit);
        return rows.map(toSessionRecord);
    }
    saveSession(input) {
        const now = createNow();
        const existing = this.db
            .prepare("SELECT created_at FROM sessions WHERE id = ?")
            .get(input.id);
        this.db
            .prepare(`
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
        `)
            .run(input.id, input.wechatAccountId, input.contactId, input.role, input.status ?? "active", input.summaryText ?? "", input.memoryJson ?? "{}", input.contextToken ?? "", input.lastActiveAt ?? now, existing?.created_at ?? now, now);
        const saved = this.db
            .prepare("SELECT * FROM sessions WHERE id = ?")
            .get(input.id);
        if (!saved) {
            throw new Error(`Failed to save session ${input.id}`);
        }
        return toSessionRecord(saved);
    }
    appendMessage(input) {
        this.db
            .prepare(`
        INSERT INTO messages (
          id, session_id, direction, message_type, text_content,
          file_path, created_at, source_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
            .run(input.id, input.sessionId, input.direction, input.messageType, input.textContent ?? null, input.filePath ?? null, input.createdAt, input.sourceMessageId ?? null);
    }
    listSessionMessages(sessionId, limit = 10) {
        const rows = this.db
            .prepare(`
        SELECT * FROM messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        `)
            .all(sessionId, limit);
        return rows.map((row) => ({
            id: String(row.id),
            sessionId: String(row.session_id),
            direction: String(row.direction),
            messageType: String(row.message_type),
            ...(row.text_content ? { textContent: String(row.text_content) } : {}),
            ...(row.file_path ? { filePath: String(row.file_path) } : {}),
            createdAt: String(row.created_at),
            ...(row.source_message_id
                ? { sourceMessageId: String(row.source_message_id) }
                : {}),
        }));
    }
    saveAttachment(input) {
        const createdAt = input.createdAt ?? createNow();
        this.db
            .prepare(`
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
        `)
            .run(input.id, input.sessionId, input.localPath, input.mimeType, input.fileName, input.sizeBytes, input.outboundStatus, createdAt);
        const saved = this.getAttachmentById(input.id);
        if (!saved) {
            throw new Error(`Failed to save attachment ${input.id}`);
        }
        return saved;
    }
    getAttachmentById(attachmentId) {
        const row = this.db
            .prepare("SELECT * FROM attachments WHERE id = ?")
            .get(attachmentId);
        return row ? toAttachmentRecord(row) : undefined;
    }
    updateAttachmentStatus(attachmentId, outboundStatus) {
        this.db
            .prepare(`
        UPDATE attachments
        SET outbound_status = ?
        WHERE id = ?
        `)
            .run(outboundStatus, attachmentId);
        const updated = this.getAttachmentById(attachmentId);
        if (!updated) {
            throw new Error(`Attachment not found: ${attachmentId}`);
        }
        return updated;
    }
}
exports.AppDatabase = AppDatabase;
