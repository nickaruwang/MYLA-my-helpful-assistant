import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, ApprovalRequest, ChatMessage, MemoryFact, ToolCallProposal } from "@jarvis/shared";

export type JarvisDatabase = Database.Database;

const DEFAULT_DATABASE_PATH = "./data/jarvis.sqlite";

export function getDatabasePath(): string {
  return process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
}

export function openDatabase(path = getDatabasePath()): JarvisDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: JarvisDatabase): void {
  const migrationPath = join(fileURLToPath(new URL("../migrations/001_initial.sql", import.meta.url)));
  const migration = readFileSync(migrationPath, "utf8");
  db.exec(migration);
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)").run("001_initial");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createSession(db: JarvisDatabase, title?: string): string {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    id,
    title ?? null,
    now,
    now
  );
  return id;
}

export function ensureSession(db: JarvisDatabase, sessionId?: string): string {
  if (!sessionId) {
    return createSession(db);
  }

  const row = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (row) {
    return sessionId;
  }

  const now = nowIso();
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    null,
    now,
    now
  );
  return sessionId;
}

export function storeMessage(
  db: JarvisDatabase,
  input: {
    sessionId: string;
    actor: Actor;
    content: string;
    correlationId: string;
  }
): ChatMessage {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    actor: input.actor,
    content: input.content,
    correlationId: input.correlationId,
    createdAt: nowIso()
  };

  db.prepare(
    "INSERT INTO messages (id, session_id, actor, content, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(message.id, message.sessionId, message.actor, message.content, message.correlationId, message.createdAt);
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(message.createdAt, message.sessionId);

  return message;
}

export function listMessages(db: JarvisDatabase, sessionId: string, limit = 50): ChatMessage[] {
  const rows = db
    .prepare(
      "SELECT id, session_id, actor, content, correlation_id, created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(sessionId, limit) as Array<{
    id: string;
    session_id: string;
    actor: Actor;
    content: string;
    correlation_id: string;
    created_at: string;
  }>;

  return rows.reverse().map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    actor: row.actor,
    content: row.content,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  }));
}

export function storeToolProposal(db: JarvisDatabase, proposal: ToolCallProposal): void {
  db.prepare(
    `INSERT INTO tool_proposals
      (id, session_id, correlation_id, tool_name, operation, args_json, risk_level, approval_mode, dry_run_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    proposal.id,
    proposal.sessionId,
    proposal.correlationId,
    proposal.toolName,
    proposal.operation,
    JSON.stringify(proposal.args),
    proposal.riskLevel,
    proposal.approvalMode,
    proposal.dryRunSummary,
    proposal.createdAt
  );
}

export function storeApproval(db: JarvisDatabase, approval: ApprovalRequest): void {
  db.prepare(
    `INSERT INTO approvals
      (id, proposal_id, session_id, explanation, status, expires_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    approval.id,
    approval.proposalId,
    approval.sessionId,
    approval.explanation,
    approval.status,
    approval.expiresAt,
    approval.decidedAt
  );
}

export function listPendingApprovals(db: JarvisDatabase): ApprovalRequest[] {
  const rows = db
    .prepare(
      `SELECT id, proposal_id, session_id, explanation, status, expires_at, decided_at
       FROM approvals
       WHERE status = 'pending'
       ORDER BY expires_at ASC`
    )
    .all() as Array<{
    id: string;
    proposal_id: string;
    session_id: string;
    explanation: string;
    status: ApprovalRequest["status"];
    expires_at: string;
    decided_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    proposalId: row.proposal_id,
    sessionId: row.session_id,
    explanation: row.explanation,
    status: row.status,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at
  }));
}

export function storeMemoryFact(db: JarvisDatabase, fact: MemoryFact): void {
  db.prepare(
    `INSERT INTO memory_facts
      (id, subject, predicate, object, source_message_id, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fact.id,
    fact.subject,
    fact.predicate,
    fact.object,
    fact.sourceMessageId,
    fact.confidence,
    fact.createdAt,
    fact.updatedAt
  );
}
