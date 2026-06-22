import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ApprovalRequest, ChatMessage, MemoryFact, Session, ToolCallProposal } from "@jarvis/shared";
import { migrate, openDatabase } from "./index.js";

const sqlitePath = process.argv[2] ?? "./data/jarvis.sqlite";

if (!existsSync(sqlitePath)) {
  console.error(`SQLite file not found: ${sqlitePath}`);
  process.exit(1);
}

const db = await openDatabase();
await migrate(db);

const sessions = querySqlite<{
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}>(sqlitePath, "SELECT id, title, created_at, updated_at FROM sessions");
if (sessions.length) {
  await db.sessions.bulkWrite(
    sessions.map((row) => ({
      updateOne: {
        filter: { id: row.id },
        update: {
          $set: {
            id: row.id,
            title: row.title,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          } satisfies Session
        },
        upsert: true
      }
    }))
  );
}

const messages = querySqlite<{
  id: string;
  session_id: string;
  actor: ChatMessage["actor"];
  content: string;
  correlation_id: string;
  created_at: string;
}>(sqlitePath, "SELECT id, session_id, actor, content, correlation_id, created_at FROM messages");
if (messages.length) {
  await db.messages.bulkWrite(
    messages.map((row) => ({
      updateOne: {
        filter: { id: row.id },
        update: {
          $set: {
            id: row.id,
            sessionId: row.session_id,
            actor: row.actor,
            content: row.content,
            correlationId: row.correlation_id,
            createdAt: row.created_at
          } satisfies ChatMessage
        },
        upsert: true
      }
    }))
  );
}

const proposals = querySqlite<{
  id: string;
  session_id: string;
  correlation_id: string;
  tool_name: string;
  operation: string;
  args_json: string;
  risk_level: ToolCallProposal["riskLevel"];
  approval_mode: ToolCallProposal["approvalMode"];
  dry_run_summary: string;
  created_at: string;
}>(sqlitePath, "SELECT id, session_id, correlation_id, tool_name, operation, args_json, risk_level, approval_mode, dry_run_summary, created_at FROM tool_proposals");
if (proposals.length) {
  await db.toolProposals.bulkWrite(
    proposals.map((row) => ({
      updateOne: {
        filter: { id: row.id },
        update: {
          $set: {
            id: row.id,
            sessionId: row.session_id,
            correlationId: row.correlation_id,
            provider: row.tool_name.split(".")[0] ?? "unknown",
            toolName: row.tool_name,
            operation: row.operation,
            args: parseJsonRecord(row.args_json),
            requiredScopes: [],
            riskLevel: row.risk_level,
            approvalMode: row.approval_mode,
            status: row.approval_mode === "manual" ? "queued_for_approval" : "executed",
            dryRunSummary: row.dry_run_summary,
            createdAt: row.created_at,
            decidedAt: null,
            executedAt: null
          } satisfies ToolCallProposal
        },
        upsert: true
      }
    }))
  );
}

const approvals = querySqlite<{
  id: string;
  proposal_id: string;
  session_id: string;
  explanation: string;
  status: ApprovalRequest["status"];
  expires_at: string;
  decided_at: string | null;
}>(sqlitePath, "SELECT id, proposal_id, session_id, explanation, status, expires_at, decided_at FROM approvals");
if (approvals.length) {
  await db.approvals.bulkWrite(
    approvals.map((row) => ({
      updateOne: {
        filter: { id: row.id },
        update: {
          $set: {
            id: row.id,
            proposalId: row.proposal_id,
            sessionId: row.session_id,
            explanation: row.explanation,
            status: row.status,
            expiresAt: row.expires_at,
            decidedAt: row.decided_at
          } satisfies ApprovalRequest
        },
        upsert: true
      }
    }))
  );
}

const memoryFacts = querySqlite<{
  id: string;
  subject: string;
  predicate: string;
  object: string;
  source_message_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}>(sqlitePath, "SELECT id, subject, predicate, object, source_message_id, confidence, created_at, updated_at FROM memory_facts");
if (memoryFacts.length) {
  await db.memoryFacts.bulkWrite(
    memoryFacts.map((row) => ({
      updateOne: {
        filter: { id: row.id },
        update: {
          $set: {
            id: row.id,
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            sourceMessageId: row.source_message_id,
            confidence: row.confidence,
            embeddingId: null,
            createdAt: row.created_at,
            updatedAt: row.updated_at
          } satisfies MemoryFact
        },
        upsert: true
      }
    }))
  );
}

await db.close();

console.log(
  `Imported ${sessions.length} sessions, ${messages.length} messages, ${proposals.length} proposals, ${approvals.length} approvals, and ${memoryFacts.length} memory facts.`
);

function querySqlite<T>(path: string, sql: string): T[] {
  const output = execFileSync("sqlite3", ["-json", path, sql], { encoding: "utf8" });
  return output.trim() ? (JSON.parse(output) as T[]) : [];
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
