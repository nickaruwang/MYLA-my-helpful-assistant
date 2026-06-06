import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventKind } from "@jarvis/shared";
import type { JarvisDatabase } from "@jarvis/db";
import { nowIso } from "@jarvis/db";

const GENESIS_HASH = "0".repeat(64);

export interface AppendAuditEventInput {
  actor: string;
  kind: AuditEventKind;
  correlationId: string;
  payload: Record<string, unknown>;
}

export interface VerificationResult {
  ok: boolean;
  checked: number;
  failedAtSeq?: number;
  expectedHash?: string;
  actualHash?: string;
}

export function appendAuditEvent(db: JarvisDatabase, input: AppendAuditEventInput): AuditEvent {
  const event = db.transaction(() => {
    const last = db
      .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;

    const seq = last ? last.seq + 1 : 1;
    const previousHash = last?.hash ?? GENESIS_HASH;
    const payloadJson = canonicalStringify(input.payload);
    const payloadDigest = digest(payloadJson);
    const createdAt = nowIso();
    const id = randomUUID();
    const hash = hashRecord({
      seq,
      id,
      actor: input.actor,
      kind: input.kind,
      correlationId: input.correlationId,
      payloadDigest,
      previousHash,
      createdAt
    });

    db.prepare(
      `INSERT INTO audit_events
        (seq, id, actor, kind, correlation_id, payload_json, payload_digest, previous_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      seq,
      id,
      input.actor,
      input.kind,
      input.correlationId,
      payloadJson,
      payloadDigest,
      previousHash,
      hash,
      createdAt
    );

    return {
      seq,
      id,
      actor: input.actor,
      kind: input.kind,
      correlationId: input.correlationId,
      payload: input.payload,
      payloadDigest,
      previousHash,
      hash,
      createdAt
    } satisfies AuditEvent;
  })();

  return event;
}

export function verifyAuditChain(db: JarvisDatabase): VerificationResult {
  const rows = db
    .prepare(
      `SELECT seq, id, actor, kind, correlation_id, payload_json, payload_digest, previous_hash, hash, created_at
       FROM audit_events
       ORDER BY seq ASC`
    )
    .all() as Array<{
    seq: number;
    id: string;
    actor: string;
    kind: AuditEventKind;
    correlation_id: string;
    payload_json: string;
    payload_digest: string;
    previous_hash: string;
    hash: string;
    created_at: string;
  }>;

  let previousHash = GENESIS_HASH;

  for (const row of rows) {
    const expectedDigest = digest(row.payload_json);
    if (expectedDigest !== row.payload_digest) {
      return {
        ok: false,
        checked: row.seq - 1,
        failedAtSeq: row.seq,
        expectedHash: expectedDigest,
        actualHash: row.payload_digest
      };
    }

    if (row.previous_hash !== previousHash) {
      return {
        ok: false,
        checked: row.seq - 1,
        failedAtSeq: row.seq,
        expectedHash: previousHash,
        actualHash: row.previous_hash
      };
    }

    const expectedHash = hashRecord({
      seq: row.seq,
      id: row.id,
      actor: row.actor,
      kind: row.kind,
      correlationId: row.correlation_id,
      payloadDigest: row.payload_digest,
      previousHash: row.previous_hash,
      createdAt: row.created_at
    });

    if (expectedHash !== row.hash) {
      return {
        ok: false,
        checked: row.seq - 1,
        failedAtSeq: row.seq,
        expectedHash,
        actualHash: row.hash
      };
    }

    previousHash = row.hash;
  }

  return { ok: true, checked: rows.length };
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }

  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashRecord(record: Record<string, unknown>): string {
  const serialized = canonicalStringify(record);
  const key = process.env.AUDIT_HMAC_KEY;
  if (key) {
    return createHmac("sha256", key).update(serialized).digest("hex");
  }

  return digest(serialized);
}
