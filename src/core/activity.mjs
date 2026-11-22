/**
 * 后台活动的"人话"投影：事件流 -> 谁在干什么、跑了多久、有没有动静。
 * 只读，不改账本；真正的真源永远是 events 表。
 */

export const RUNNING_STATES = ["queued", "planning", "implementing", "verifying", "reviewing", "merging"];

const MAX_STR = 200;

export function parsePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return { text: String(raw) }; }
}

function slimValue(v, depth) {
  if (v == null) return v;
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length + " 项";
  if (typeof v === "object" && depth < 2) return slimPayload(v, depth + 1);
  return "[object]";
}

/**
 * 事件负载里可能塞着 12KB 的 diff 或整份方案；界面只给人看"是什么"，不搬运正文。
 * 保留两层结构（verify.verdict 这种要给界面用），更深的直接记 [object]。
 */
export function slimPayload(payload, depth = 0) {
  const p = parsePayload(payload);
  const out = {};
  for (const [k, v] of Object.entries(p || {})) out[k] = slimValue(v, depth);
  return out;
}

function titleMap(db) {
  const m = new Map();
  for (const row of db.prepare("SELECT id, title, state FROM tasks").all()) m.set(row.id, row);
  return m;
}

/** 增量拉取：since=0 取最近 limit 条（升序返回），否则取 id > since。 */
export function feed(db, { since = 0, limit = 120, task = null } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 120));
  const rows = task
    ? (Number(since) > 0
        ? db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(task, Number(since), lim)
        : db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(task, lim).reverse())
    : Number(since) > 0
    ? db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(Number(since), lim)
    : db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(lim).reverse();
  const titles = titleMap(db);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    taskId: r.task_id,
    title: r.task_id ? (titles.get(r.task_id) || {}).title ?? null : null,
    type: r.type,
    actor: r.actor,
    payload: slimPayload(r.payload),
  }));
}

function silentThreshold() {
  return Number(process.env.WB_SILENT_MS || 60000);
}

/**
 * 每个在跑的任务"此刻在做什么"：
 * - 有 agent.started 但还没有 agent.finished => 正在跑那个角色，elapsed_s 是它的时长；
 * - 否则退到最近一条事件（人至少能看出"最后一步是什么、多少秒没动静"）；
 * - stalled：超过 WB_SILENT_MS（默认 60s）没有任何事件 —— 活着的 worker 每 15s 会落一条
 *   agent.heartbeat，所以"静默"就是真的没人在跑。
 */
export function live(db, now = Date.now()) {
  const threshold = silentThreshold();
  const sql = "SELECT id, title, state, attempts, spent_tokens, budget_tokens FROM tasks " +
    "WHERE state IN (" + RUNNING_STATES.map(() => "?").join(",") + ") ORDER BY created_at ASC";
  const rows = db.prepare(sql).all(...RUNNING_STATES);
  const out = [];
  for (const t of rows) {
    const evs = db.prepare("SELECT id, ts, type, payload FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 60").all(t.id);
    const started = evs.find((e) => e.type === "agent.started");
    const doneAfter = started ? evs.some((e) => e.type === "agent.finished" && e.id > started.id) : false;
    const last = evs[0] || null;
    const silent = last ? Math.max(0, Math.round((now - Date.parse(last.ts)) / 1000)) : null;
    let role = null, elapsed = null;
    if (started && !doneAfter) {
      role = parsePayload(started.payload).role || "agent";
      elapsed = Math.max(0, Math.round((now - Date.parse(started.ts)) / 1000));
    }
    out.push({
      taskId: t.id, title: t.title, state: t.state,
      attempts: t.attempts, spent: t.spent_tokens, budget: t.budget_tokens,
      role, elapsed_s: elapsed,
      last_type: last ? last.type : null,
      last_ts: last ? last.ts : null,
      silent_s: silent,
      stalled: silent != null && silent * 1000 > threshold,
    });
  }
  return out;
}
