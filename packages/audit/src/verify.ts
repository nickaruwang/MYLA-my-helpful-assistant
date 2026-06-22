import { migrate, openDatabase } from "@jarvis/db";
import { verifyAuditChain } from "./index.js";

const db = await openDatabase();
await migrate(db);

const result = await verifyAuditChain(db);
await db.close();

if (!result.ok) {
  console.error(`Audit verification failed at seq ${result.failedAtSeq}.`);
  process.exit(1);
}

console.log(`Audit chain verified. Checked ${result.checked} events.`);
