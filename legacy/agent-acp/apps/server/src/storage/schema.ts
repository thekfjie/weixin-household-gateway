export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS wechat_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'family')),
  auth_token TEXT NOT NULL,
  uin TEXT NOT NULL,
  base_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  wechat_account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  display_name TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS polling_state (
  wechat_account_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  wechat_account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'family')),
  status TEXT NOT NULL DEFAULT 'active',
  summary_text TEXT NOT NULL DEFAULT '',
  memory_json TEXT NOT NULL DEFAULT '{}',
  context_token TEXT NOT NULL DEFAULT '',
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  message_type TEXT NOT NULL,
  text_content TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  source_message_id TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  outbound_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_role_settings (
  role TEXT PRIMARY KEY CHECK(role IN ('admin', 'family')),
  model TEXT,
  reasoning_effort TEXT,
  updated_at TEXT NOT NULL
);
`;
