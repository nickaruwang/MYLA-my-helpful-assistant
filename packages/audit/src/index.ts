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

export async function appendAuditEvent(db: JarvisDatabase, input: AppendAuditEventInput): Promise<AuditEvent> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await appendAuditEventOnce(db, input);
    } catch (error) {
      if (!isDuplicateKeyError(error) || attempt === 4) {
        throw error;
      }
    }
  }

  throw new Error("Unable to append audit event.");
}

async function appendAuditEventOnce(db: JarvisDatabase, input: AppendAuditEventInput): Promise<AuditEvent> {
  const last = (await db.auditEvents
    .find({}, { projection: { _id: 0, seq: 1, hash: 1 } })
    .sort({ seq: -1 })
    .limit(1)
    .next()) as { seq: number; hash: string } | null;

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

  const event = {
    seq,
    id,
    actor: input.actor,
    kind: input.kind,
    correlationId: input.correlationId,
    payload: input.payload,
    payloadJson,
    payloadDigest,
    previousHash,
    hash,
    createdAt
  };

  await db.auditEvents.insertOne(event);

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
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 11000);
}

export async function verifyAuditChain(db: JarvisDatabase): Promise<VerificationResult> {
  const rows = (await db.auditEvents
    .find({}, { projection: { _id: 0 } })
    .sort({ seq: 1 })
    .toArray()) as unknown as Array<{
    seq: number;
    id: string;
    actor: string;
    kind: AuditEventKind;
    correlationId: string;
    payloadJson: string;
    payloadDigest: string;
    previousHash: string;
    hash: string;
    createdAt: string;
  }>;

  let previousHash = GENESIS_HASH;

  for (const row of rows) {
    const expectedDigest = digest(row.payloadJson);
    if (expectedDigest !== row.payloadDigest) {
      return {
        ok: false,
        checked: row.seq - 1,
        failedAtSeq: row.seq,
        expectedHash: expectedDigest,
        actualHash: row.payloadDigest
      };
    }

    if (row.previousHash !== previousHash) {
      return {
        ok: false,
        checked: row.seq - 1,
        failedAtSeq: row.seq,
        expectedHash: previousHash,
        actualHash: row.previousHash
      };
    }

    const expectedHash = hashRecord({
      seq: row.seq,
      id: row.id,
      actor: row.actor,
      kind: row.kind,
      correlationId: row.correlationId,
      payloadDigest: row.payloadDigest,
      previousHash: row.previousHash,
      createdAt: row.createdAt
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
