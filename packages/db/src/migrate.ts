import { migrate, openDatabase } from "./index.js";

const db = openDatabase();
migrate(db);
db.close();

console.log("SQLite migrations applied.");
