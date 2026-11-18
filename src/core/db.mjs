import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(process.cwd());
export const DB_PATH = resolve(process.env.WB_DB ?? resolve(ROOT, "data/ledger.db"));

/**
 * 打开账本。
 * events 是唯一真源，tasks 是物化投影（可从 events 全量重建）。
 */
export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 8000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      task_id   TEXT,
      type      TEXT NOT NULL,
      actor     TEXT NOT NULL,
      payload   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);

    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      branch          TEXT,
      base_sha        TEXT,
      owner           TEXT NOT NULL,
      state           TEXT NOT NULL,
      lease_owner     TEXT,
      lease_expires_at INTEGER,
      budget_tokens   INTEGER NOT NULL DEFAULT 200000,
      spent_tokens    INTEGER NOT NULL DEFAULT 0,
      attempts        INTEGER NOT NULL DEFAULT 0,
      plan_md         TEXT,
      diff_stat       TEXT,
      evidence        TEXT,
      decision        TEXT NOT NULL DEFAULT 'pending',
      decision_note   TEXT,
      review_started_at INTEGER,
      review_seconds  INTEGER,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, created_at);
  `);
}
