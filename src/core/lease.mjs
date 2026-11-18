import { record } from "./ledger.mjs";

/**
 * 租约：用一条 CAS UPDATE 做互斥，抢不到就是抢不到，不存在"两个 worker 同时跑一个任务"。
 */
export function acquire(db, taskId, owner, ttlMs = 180_000) {
  const now = Date.now();
  const r = db.prepare(`UPDATE tasks
      SET lease_owner = ?, lease_expires_at = ?
      WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`)
    .run(owner, now + ttlMs, taskId, now, owner);
  if (r.changes === 0) return false;
  record(db, {
    taskId, type: "lease.acquired", actor: owner,
    payload: { owner, expires_at: now + ttlMs },
  }, false);
  return true;
}

export function renew(db, taskId, owner, ttlMs = 180_000) {
  const now = Date.now();
  const r = db.prepare(`UPDATE tasks SET lease_expires_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_expires_at >= ?`)
    .run(now + ttlMs, taskId, owner, now);
  if (r.changes === 0) return false;
  record(db, { taskId, type: "lease.renewed", actor: owner, payload: { expires_at: now + ttlMs } }, false);
  return true;
}

export function release(db, taskId, owner, reason = null) {
  const r = db.prepare("UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
    .run(taskId, owner);
  if (r.changes === 0) return false;
  record(db, { taskId, type: "lease.released", actor: owner, payload: { reason } }, false);
  return true;
}

/** 扫掉过期租约，让崩溃 worker 留下的任务重新可被认领。 */
export function reclaimExpired(db) {
  const now = Date.now();
  const rows = db.prepare("SELECT id, lease_owner FROM tasks WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?").all(now);
  for (const r of rows) {
    db.prepare("UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(r.id);
    record(db, { taskId: r.id, type: "lease.released", actor: "reaper", payload: { reason: "expired", was: r.lease_owner } }, false);
  }
  return rows.map((r) => r.id);
}
