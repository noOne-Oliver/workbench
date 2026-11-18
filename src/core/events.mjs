/** 只负责写/读事件流，不含业务语义。 */

export function append(db, { taskId = null, type, actor = "system", payload = {} }) {
  const ts = new Date().toISOString();
  db.prepare(
    "INSERT INTO events (ts, task_id, type, actor, payload) VALUES (?, ?, ?, ?, ?)"
  ).run(ts, taskId, type, actor, JSON.stringify(payload));
  return { ts, taskId, type, actor, payload };
}

export function *readAll(db) {
  for (const row of db.prepare("SELECT * FROM events ORDER BY id ASC").all()) {
    yield row;
  }
}

export function readForTask(db, taskId) {
  return db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC").all(taskId);
}

export function readSince(db, id) {
  return db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC").all(id);
}

export function countEvents(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
}
