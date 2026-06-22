import { migrate, openDatabase } from "./index.js";

const db = await openDatabase();
await migrate(db);
await db.close();

console.log("MongoDB indexes applied.");
