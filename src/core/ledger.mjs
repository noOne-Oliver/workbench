import { append, readAll } from "./events.mjs";
import { newId } from "./ids.mjs";

/**
 * 状态机。所有迁移必须在这里声明，未声明的迁移一律拒绝——这是"账本先于执行器"的落点。
 */
export const STATES = [
  "queued", "planning", "implementing", "verifying",
  "reviewing", "awaiting_human", "merging", "done",
  "failed", "blocked",
];

export const TRANSITIONS = {
  queued:          ["planning", "blocked", "failed"],
  planning:        ["implementing", "queued", "blocked", "failed"],
  implementing:    ["verifying", "queued", "blocked", "failed"],
  verifying:       ["reviewing", "implementing", "blocked", "failed"],
  reviewing:       ["awaiting_human", "implementing", "blocked", "failed"],
  awaiting_human:  ["merging", "queued", "failed"],           // approve / changes_requested
  merging:         ["done", "awaiting_human", "failed"],
  done:            [],
  failed:          ["queued"],
  blocked:         ["queued"],
};

const TERMINAL = new Set(["done"]);

/** 写一条事件并同步应用到投影。apply=false 用于调用方已用 CAS 改过行的场景。 */
export function record(db, { taskId = null, type, actor = "system", payload = {} }, apply = true) {
  const ev = append(db, { taskId, type, actor, payload });
  // append() 返回驼峰字段，投影层统一用 snake_case（与 events 表列名一致）
  if (apply) applyEvent(db, { ...ev, task_id: taskId, payload: JSON.stringify(payload) });
  return ev;
}

export function createTask(db, { title, repo, owner = "unknown", budgetTokens = 1_000_000, baseSha = null, branch = null }) {
  if (!title || !repo) throw new Error("title 与 repo 必填");
  const id = newId();
  record(db, {
    taskId: id,
    type: "task.created",
    actor: owner,
    payload: { title, repo, owner, budget_tokens: budgetTokens, base_sha: baseSha, branch },
  });
  return getTask(db, id);
}

export function getTask(db, id) {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

export function listTasks(db, { state = null, owner = null, limit = 200 } = {}) {
  let sql = "SELECT * FROM tasks";
  const where = [], args = [];
  if (state) { where.push("state = ?"); args.push(state); }
  if (owner) { where.push("owner = ?"); args.push(owner); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args).map(hydrate);
}

/** 严格迁移：同态直接返回（幂等），非法迁移抛错。 */
export function transition(db, id, to, { actor = "system", reason = null } = {}) {
  const t = getTask(db, id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.state === to) return t;
  const allowed = TRANSITIONS[t.state] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法迁移 ${t.state} -> ${to} (任务 ${id})`);
  }
  record(db, {
    taskId: id,
    type: "task.transition",
    actor,
    payload: { from: t.state, to, reason },
  });
  return getTask(db, id);
}

export function isTerminal(state) {
  return TERMINAL.has(state);
}

export function addEvidence(db, id, patch, type = "evidence.patch", actor = "system") {
  const t = getTask(db, id);
  const merged = { ...(t?.evidence ?? {}), ...patch };
  record(db, { taskId: id, type: "evidence.patch", actor, payload: merged });
  return merged;
}

export function spendBudget(db, id, tokens, detail = null) {
  if (!tokens || tokens <= 0) return getTask(db, id);
  record(db, { taskId: id, type: "budget.spent", payload: { tokens, detail } });
  return getTask(db, id);
}

export function overBudget(t) {
  return t.spent_tokens >= t.budget_tokens;
}

/** 从事件流全量重建投影——kill -9 之后的自愈入口。 */
export function rebuild(db) {
  db.exec("DELETE FROM tasks;");
  for (const row of readAll(db)) applyEvent(db, row);
  return db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
}

const nowIso = () => new Date().toISOString();

/** 事件 -> 投影。唯一允许改 tasks 表的地方。 */
export function applyEvent(db, ev) {
  const p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
  switch (ev.type) {
    case "task.created": {
      db.prepare(`INSERT OR REPLACE INTO tasks
        (id,title,repo,branch,base_sha,owner,state,budget_tokens,spent_tokens,attempts,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`)
        .run(ev.task_id, p.title, p.repo, p.branch ?? null, p.base_sha ?? null,
             p.owner, "queued", p.budget_tokens ?? 200000, ev.ts, ev.ts);
      break;
    }
    case "task.transition": {
      const t = db.prepare("SELECT state, review_started_at FROM tasks WHERE id = ?").get(ev.task_id);
      if (!t) break;
      const nowMs = Date.parse(ev.ts);
      let reviewStarted = t.review_started_at ?? null;
      let reviewSeconds = null;
      if (p.to === "awaiting_human") reviewStarted = nowMs;
      if (t.state === "awaiting_human" && p.to !== "awaiting_human" && reviewStarted) {
        reviewSeconds = Math.max(0, Math.round((nowMs - reviewStarted) / 1000));
        reviewStarted = null;
      }
      db.prepare(`UPDATE tasks SET state=?, updated_at=?,
        review_started_at = COALESCE(?, review_started_at),
        review_seconds = COALESCE(?, review_seconds) WHERE id=?`)
        .run(p.to, ev.ts, reviewStarted, reviewSeconds, ev.task_id);
      break;
    }
    case "lease.acquired":
      db.prepare("UPDATE tasks SET lease_owner=?, lease_expires_at=?, updated_at=? WHERE id=?")
        .run(p.owner, p.expires_at, ev.ts, ev.task_id);
      break;
    case "lease.renewed":
      db.prepare("UPDATE tasks SET lease_expires_at=?, updated_at=? WHERE id=?")
        .run(p.expires_at, ev.ts, ev.task_id);
      break;
    case "lease.released":
      db.prepare("UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
        .run(ev.ts, ev.task_id);
      break;
    case "plan.produced":
      db.prepare("UPDATE tasks SET plan_md=?, updated_at=? WHERE id=?").run(p.plan_md, ev.ts, ev.task_id);
      break;
    case "impl.produced":
      db.prepare("UPDATE tasks SET diff_stat=?, branch=?, base_sha=COALESCE(?, base_sha), updated_at=? WHERE id=?")
        .run(p.diff_stat ?? null, p.branch ?? null, p.base_sha ?? null, ev.ts, ev.task_id);
      break;
    case "verify.result":
    case "evidence.patch":
      db.prepare("UPDATE tasks SET evidence=?, updated_at=? WHERE id=?").run(JSON.stringify(p), ev.ts, ev.task_id);
      break;
    case "budget.spent":
      db.prepare("UPDATE tasks SET spent_tokens = spent_tokens + ?, updated_at=? WHERE id=?")
        .run(p.tokens, ev.ts, ev.task_id);
      break;
    case "attempt.started":
      db.prepare("UPDATE tasks SET attempts = attempts + 1, updated_at=? WHERE id=?").run(ev.ts, ev.task_id);
      break;
    case "human.decision":
      db.prepare("UPDATE tasks SET decision=?, decision_note=?, updated_at=? WHERE id=?")
        .run(p.decision, p.note ?? null, ev.ts, ev.task_id);
      break;
    default:
      break;
  }
}

function hydrate(row) {
  let evidence = null;
  if (row.evidence) { try { evidence = JSON.parse(row.evidence); } catch { evidence = { raw: row.evidence }; } }
  return { ...row, evidence };
}
