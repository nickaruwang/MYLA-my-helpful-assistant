PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  correlation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  args_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  dry_run_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES tool_proposals(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status
  ON approvals(status, expires_at);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_subject
  ON memory_facts(subject);

CREATE TABLE IF NOT EXISTS memory_relationships (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL,
  relationship TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  source_fact_id TEXT REFERENCES memory_facts(id) ON DELETE SET NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_relationships_from
  ON memory_relationships(from_entity);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
