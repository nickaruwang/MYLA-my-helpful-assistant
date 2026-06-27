import { MongoClient, type Collection, type Db } from "mongodb";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Actor,
  ApprovalRequest,
  ChatMessage,
  MemoryFact,
  MemoryRelationship,
  MemorySearchResult,
  PlannerTrace,
  Session,
  ToolCallProposal,
  ToolTask,
  ToolTaskStatus,
  ToolProposalStatus
} from "@myla/shared";

export interface MylaDatabase {
  client: MongoClient;
  db: Db;
  sessions: Collection<Session>;
  messages: Collection<ChatMessage>;
  toolProposals: Collection<ToolCallProposal>;
  toolTasks: Collection<ToolTask>;
  approvals: Collection<ApprovalRequest>;
  memoryFacts: Collection<MemoryFact>;
  memoryRelationships: Collection<MemoryRelationship>;
  plannerTraces: Collection<PlannerTrace>;
  auditEvents: Collection<Record<string, unknown>>;
  close: () => Promise<void>;
}

const DEFAULT_MONGODB_URI = "mongodb://localhost:27017";
const DEFAULT_MONGODB_DATABASE = "myla";
const DEFAULT_QDRANT_COLLECTION = "myla_memory";

loadLocalEnv();

export function getMongoUri(): string {
  return process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
}

export function getMongoDatabaseName(): string {
  return process.env.MONGODB_DATABASE ?? DEFAULT_MONGODB_DATABASE;
}

export async function openDatabase(uri = getMongoUri(), databaseName = getMongoDatabaseName()): Promise<MylaDatabase> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(databaseName);

  return {
    client,
    db,
    sessions: db.collection<Session>("sessions"),
    messages: db.collection<ChatMessage>("messages"),
    toolProposals: db.collection<ToolCallProposal>("tool_proposals"),
    toolTasks: db.collection<ToolTask>("tool_tasks"),
    approvals: db.collection<ApprovalRequest>("approvals"),
    memoryFacts: db.collection<MemoryFact>("memory_facts"),
    memoryRelationships: db.collection<MemoryRelationship>("memory_relationships"),
    plannerTraces: db.collection<PlannerTrace>("planner_traces"),
    auditEvents: db.collection<Record<string, unknown>>("audit_events"),
    close: () => client.close()
  };
}

export async function migrate(db: MylaDatabase): Promise<void> {
  await Promise.all([
    db.sessions.createIndex({ id: 1 }, { unique: true }),
    db.sessions.createIndex({ updatedAt: -1 }),
    db.messages.createIndex({ sessionId: 1, createdAt: -1 }),
    db.toolProposals.createIndex({ id: 1 }, { unique: true }),
    db.toolProposals.createIndex({ sessionId: 1, createdAt: -1 }),
    db.toolTasks.createIndex({ id: 1 }, { unique: true }),
    db.toolTasks.createIndex({ sessionId: 1, updatedAt: -1 }),
    db.toolTasks.createIndex({ status: 1, expiresAt: 1 }),
    db.approvals.createIndex({ id: 1 }, { unique: true }),
    db.approvals.createIndex({ status: 1, expiresAt: 1 }),
    db.memoryFacts.createIndex({ id: 1 }, { unique: true }),
    db.memoryFacts.createIndex({ subject: 1, updatedAt: -1 }),
    db.memoryFacts.createIndex({ object: "text", subject: "text", predicate: "text" }),
    db.memoryRelationships.createIndex({ fromEntity: 1 }),
    db.plannerTraces.createIndex({ correlationId: 1 }),
    db.plannerTraces.createIndex({ sessionId: 1, createdAt: -1 }),
    db.auditEvents.createIndex({ seq: 1 }, { unique: true }),
    db.auditEvents.createIndex({ id: 1 }, { unique: true })
  ]);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function createSession(db: MylaDatabase, title?: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.sessions.insertOne({
    id,
    title: title ?? null,
    createdAt: now,
    updatedAt: now
  });
  return id;
}

export async function ensureSession(db: MylaDatabase, sessionId?: string): Promise<string> {
  if (!sessionId) {
    return createSession(db);
  }

  const existing = await db.sessions.findOne({ id: sessionId });
  if (existing) {
    return sessionId;
  }

  const now = nowIso();
  await db.sessions.insertOne({
    id: sessionId,
    title: null,
    createdAt: now,
    updatedAt: now
  });
  return sessionId;
}

export async function listSessions(db: MylaDatabase, limit = 25): Promise<Session[]> {
  return db.sessions.find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
}

export async function storeMessage(
  db: MylaDatabase,
  input: {
    sessionId: string;
    actor: Actor;
    content: string;
    correlationId: string;
  }
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    actor: input.actor,
    content: input.content,
    correlationId: input.correlationId,
    createdAt: nowIso()
  };

  await db.messages.insertOne(message);
  await db.sessions.updateOne({ id: message.sessionId }, { $set: { updatedAt: message.createdAt } });

  return message;
}

export async function listMessages(db: MylaDatabase, sessionId: string, limit = 50): Promise<ChatMessage[]> {
  const rows = await db.messages
    .find({ sessionId }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();

  return rows.reverse().map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    actor: row.actor as Actor,
    content: row.content,
    correlationId: row.correlationId,
    createdAt: row.createdAt
  }));
}

export async function storeToolProposal(db: MylaDatabase, proposal: ToolCallProposal): Promise<void> {
  await db.toolProposals.insertOne(proposal);
}

export async function getToolProposal(db: MylaDatabase, proposalId: string): Promise<ToolCallProposal | null> {
  return db.toolProposals.findOne({ id: proposalId }, { projection: { _id: 0 } });
}

export async function updateToolProposalStatus(
  db: MylaDatabase,
  proposalId: string,
  status: ToolProposalStatus,
  updates: Partial<Pick<ToolCallProposal, "decidedAt" | "executedAt">> = {}
): Promise<void> {
  await db.toolProposals.updateOne({ id: proposalId }, { $set: { status, ...updates } });
}

export async function storeToolTask(db: MylaDatabase, task: ToolTask): Promise<void> {
  await db.toolTasks.insertOne(task);
}

export async function createToolTask(
  db: MylaDatabase,
  input: {
    sessionId: string;
    correlationId: string;
    toolName?: string | null;
    status: ToolTaskStatus;
    draftArgs?: Record<string, unknown>;
    missingFields?: string[];
    assumptions?: string[];
    validationErrors?: string[];
    proposalId?: string | null;
    approvalId?: string | null;
    resultStatus?: ToolTask["resultStatus"];
    resultNotification?: string | null;
    expiresAt?: string | null;
  }
): Promise<ToolTask> {
  const now = nowIso();
  const task: ToolTask = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    toolName: input.toolName ?? null,
    status: input.status,
    draftArgs: input.draftArgs ?? {},
    missingFields: input.missingFields ?? [],
    assumptions: input.assumptions ?? [],
    validationErrors: input.validationErrors ?? [],
    proposalId: input.proposalId ?? null,
    approvalId: input.approvalId ?? null,
    resultStatus: input.resultStatus ?? null,
    resultNotification: input.resultNotification ?? null,
    expiresAt: input.expiresAt ?? null,
    createdAt: now,
    updatedAt: now
  };
  await storeToolTask(db, task);
  return task;
}

export async function updateToolTask(
  db: MylaDatabase,
  taskId: string,
  updates: Partial<Omit<ToolTask, "id" | "sessionId" | "correlationId" | "createdAt" | "updatedAt">>
): Promise<void> {
  await db.toolTasks.updateOne({ id: taskId }, { $set: { ...updates, updatedAt: nowIso() } });
}

export async function updateToolTaskByProposalId(
  db: MylaDatabase,
  proposalId: string,
  updates: Partial<Omit<ToolTask, "id" | "sessionId" | "correlationId" | "createdAt" | "updatedAt">>
): Promise<void> {
  await db.toolTasks.updateOne({ proposalId }, { $set: { ...updates, updatedAt: nowIso() } });
}

export async function listToolTasks(db: MylaDatabase, sessionId?: string, limit = 50): Promise<ToolTask[]> {
  return db.toolTasks
    .find(sessionId ? { sessionId } : {}, { projection: { _id: 0 } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function getActiveToolTask(db: MylaDatabase, sessionId: string): Promise<ToolTask | null> {
  const now = nowIso();
  return db.toolTasks.findOne(
    {
      sessionId,
      status: { $in: ["draft", "needs_clarification", "queued_for_approval"] },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    },
    { projection: { _id: 0 }, sort: { updatedAt: -1 } }
  );
}

export async function storeApproval(db: MylaDatabase, approval: ApprovalRequest): Promise<void> {
  await db.approvals.insertOne(approval);
}

export async function getApproval(db: MylaDatabase, approvalId: string): Promise<ApprovalRequest | null> {
  return db.approvals.findOne({ id: approvalId }, { projection: { _id: 0 } });
}

export async function updateApprovalStatus(
  db: MylaDatabase,
  approvalId: string,
  status: ApprovalRequest["status"],
  decidedAt = nowIso()
): Promise<void> {
  await db.approvals.updateOne({ id: approvalId }, { $set: { status, decidedAt } });
}

export async function listPendingApprovals(db: MylaDatabase): Promise<ApprovalRequest[]> {
  return db.approvals
    .find({ status: "pending" }, { projection: { _id: 0 } })
    .sort({ expiresAt: 1 })
    .toArray();
}

export async function storeMemoryFact(
  db: MylaDatabase,
  fact: MemoryFact,
  embedding?: number[]
): Promise<MemoryFact> {
  const normalizedFact = { ...fact, embeddingId: fact.embeddingId ?? fact.id };
  await db.memoryFacts.updateOne({ id: normalizedFact.id }, { $set: normalizedFact }, { upsert: true });

  if (embedding?.length) {
    await upsertMemoryVector(normalizedFact, embedding);
  }

  return normalizedFact;
}

export async function storePlannerTrace(db: MylaDatabase, trace: PlannerTrace): Promise<void> {
  await db.plannerTraces.insertOne(trace);
}

export async function listPlannerTraces(db: MylaDatabase, sessionId?: string, limit = 50): Promise<PlannerTrace[]> {
  return db.plannerTraces
    .find(sessionId ? { sessionId } : {}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function listMemoryFacts(db: MylaDatabase, limit = 50): Promise<MemoryFact[]> {
  return db.memoryFacts.find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
}

export async function deleteMemoryFact(db: MylaDatabase, factId: string): Promise<boolean> {
  const result = await db.memoryFacts.deleteOne({ id: factId });
  await deleteMemoryVector(factId);
  return result.deletedCount > 0;
}

export async function searchMemoryFacts(
  db: MylaDatabase,
  query: string,
  options: { limit?: number; embedding?: number[] } = {}
): Promise<MemorySearchResult[]> {
  const limit = options.limit ?? 8;
  const vectorMatches = options.embedding?.length ? await searchMemoryVectors(options.embedding, limit) : [];
  if (vectorMatches.length > 0) {
    const facts = await db.memoryFacts
      .find({ id: { $in: vectorMatches.map((match) => match.factId) } }, { projection: { _id: 0 } })
      .toArray();
    const scoreById = new Map(vectorMatches.map((match) => [match.factId, match.score]));
    return facts
      .map((fact) => ({ ...fact, score: scoreById.get(fact.id) }))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  }

  const escaped = escapeRegExp(query.trim());
  if (!escaped) {
    return listMemoryFacts(db, limit);
  }

  const regex = new RegExp(escaped, "i");
  return db.memoryFacts
    .find(
      {
        $or: [{ subject: regex }, { predicate: regex }, { object: regex }]
      },
      { projection: { _id: 0 } }
    )
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}

export async function storeMemoryRelationship(
  db: MylaDatabase,
  relationship: MemoryRelationship
): Promise<MemoryRelationship> {
  await db.memoryRelationships.updateOne({ id: relationship.id }, { $set: relationship }, { upsert: true });
  return relationship;
}

async function ensureQdrantCollection(vectorSize: number): Promise<void> {
  const baseUrl = process.env.QDRANT_URL;
  if (!baseUrl) {
    return;
  }

  const collection = process.env.QDRANT_COLLECTION ?? DEFAULT_QDRANT_COLLECTION;
  const response = await qdrantFetch(`${baseUrl}/collections/${collection}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: "Cosine"
      }
    })
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`Qdrant collection setup failed with ${response.status}`);
  }
}

async function upsertMemoryVector(fact: MemoryFact, embedding: number[]): Promise<void> {
  const baseUrl = process.env.QDRANT_URL;
  if (!baseUrl) {
    return;
  }

  await ensureQdrantCollection(embedding.length);
  const collection = process.env.QDRANT_COLLECTION ?? DEFAULT_QDRANT_COLLECTION;
  const response = await qdrantFetch(`${baseUrl}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({
      points: [
        {
          id: fact.id,
          vector: embedding,
          payload: {
            factId: fact.id,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object
          }
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Qdrant upsert failed with ${response.status}`);
  }
}

async function searchMemoryVectors(embedding: number[], limit: number): Promise<Array<{ factId: string; score: number }>> {
  const baseUrl = process.env.QDRANT_URL;
  if (!baseUrl) {
    return [];
  }

  await ensureQdrantCollection(embedding.length);
  const collection = process.env.QDRANT_COLLECTION ?? DEFAULT_QDRANT_COLLECTION;
  const response = await qdrantFetch(`${baseUrl}/collections/${collection}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector: embedding,
      limit,
      with_payload: true
    })
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    result?: Array<{ score: number; payload?: { factId?: string } }>;
  };

  return (
    payload.result
      ?.map((result) => ({
        factId: result.payload?.factId,
        score: result.score
      }))
      .filter((result): result is { factId: string; score: number } => Boolean(result.factId)) ?? []
  );
}

async function deleteMemoryVector(factId: string): Promise<void> {
  const baseUrl = process.env.QDRANT_URL;
  if (!baseUrl) {
    return;
  }

  const collection = process.env.QDRANT_COLLECTION ?? DEFAULT_QDRANT_COLLECTION;
  await qdrantFetch(`${baseUrl}/collections/${collection}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({
      points: [factId]
    })
  });
}

function qdrantFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
      ...init.headers
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadLocalEnv(): void {
  const loadEnvFile = (process as typeof process & { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  const envPath = findEnvFile();
  if (!loadEnvFile || !envPath) {
    return;
  }

  try {
    loadEnvFile(envPath);
  } catch {
    // Environment variables may already be provided by Docker, CI, or the shell.
  }
}

function findEnvFile(): string | undefined {
  let current = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }

  return undefined;
}
