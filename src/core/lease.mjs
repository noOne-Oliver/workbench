import { record } from "./ledger.mjs";
import { hostname } from "node:os";

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

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * 回收"持有者进程已经不在了"的租约。
 * kill -9 不会留下遗言，等 TTL 到期是几分钟的空转；这里直接看 pid 还在不在。
 * owner 约定格式 host:pid。
 */
export function reclaimDead(db) {
  const host = hostname();
  const rows = db.prepare("SELECT id, lease_owner FROM tasks WHERE lease_owner IS NOT NULL AND lease_expires_at >= ?").all(Date.now());
  const taken = [];
  for (const r of rows) {
    const raw = String(r.lease_owner || "");
    // 兼容两种 owner 写法：host:pid 与任意前缀-pid（如 cli-12345）
    const m = raw.match(/(\d+)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const i = raw.lastIndexOf(":");
    const h = i > 0 && raw.slice(i + 1) === m[1] ? raw.slice(0, i) : host;
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (h !== host) continue;
    if (alive(pid)) continue;
    db.prepare("UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?").run(r.id, r.lease_owner);
    record(db, { taskId: r.id, type: "lease.released", actor: "reaper", payload: { reason: "owner-dead", was: r.lease_owner } }, false);
    taken.push(r.id);
  }
  return taken;
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
