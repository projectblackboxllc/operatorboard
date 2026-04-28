import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const dbPath = process.env.OPERATORBOARD_DB_PATH ?? join(process.cwd(), "data", "operatorboard.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_attestations (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

export function saveRecord(table: string, id: string, data: unknown, createdAt: string, updatedAt?: string) {
  if (table === "tasks") {
    db.prepare(`
      INSERT INTO tasks (id, data, created_at, updated_at)
      VALUES (@id, @data, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run({
      id,
      data: JSON.stringify(data),
      createdAt,
      updatedAt: updatedAt ?? createdAt
    });
    return;
  }

  db.prepare(`
    INSERT INTO ${table} (id, data, created_at)
    VALUES (@id, @data, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data
  `).run({
    id,
    data: JSON.stringify(data),
    createdAt
  });
}

export function loadRecords<T>(table: string): T[] {
  const rows = db.prepare(`SELECT data FROM ${table} ORDER BY created_at ASC`).all() as Array<{ data: string }>;
  return rows.map((row) => JSON.parse(row.data) as T);
}

export function deleteAllRecords() {
  db.exec(`
    DELETE FROM agents;
    DELETE FROM tasks;
    DELETE FROM approvals;
    DELETE FROM heartbeats;
    DELETE FROM audit_events;
    DELETE FROM backup_attestations;
  `);
}

export function deleteApprovalsForTask(taskId: string) {
  const rows = db.prepare("SELECT id, data FROM approvals").all() as Array<{ id: string; data: string }>;

  for (const row of rows) {
    const parsed = JSON.parse(row.data) as { taskId?: string };
    if (parsed.taskId === taskId) {
      db.prepare("DELETE FROM approvals WHERE id = ?").run(row.id);
    }
  }
}
