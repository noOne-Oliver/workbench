import { openDb } from "../core/db.mjs";
import { getTask, listTasks, transition, record, spendBudget, addEvidence, overBudget } from "../core/ledger.mjs";
import { acquire, renew, release, reclaimExpired, reclaimDead } from "../core/lease.mjs";
import { hostname } from "node:os";
import { getProvider } from "./engine.mjs";
import { sh, ensureWorktree, commitAll, diffStat, diffPatch, headSha, isGitRepo } from "./worktree.mjs";
import { loadRepoConfig, runGuards } from "./guards.mjs";
import * as sop from "./sop.mjs";
import { resolve, join } from "node:path";

import { BUILTIN_ENGINES } from "./providers/index.mjs";
export { BUILTIN_ENGINES };

export const ROOT = resolve(process.env.WB_ROOT || process.cwd());
const WORKTREES = resolve(ROOT, "worktrees");
const MAX_ATTEMPTS = Number(process.env.WB_MAX_ATTEMPTS || 3);
const PAUSED = new Set(["awaiting_human", "done", "blocked", "failed"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可被认领的任务：非暂停态 + 租约空闲或已过期（崩溃恢复走这条路）。 */
export function pickRunnable(db) {
  return db.prepare(
    "SELECT id FROM tasks WHERE state NOT IN ('awaiting_human','done','blocked','failed') " +
    "AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY created_at ASC LIMIT 1"
  ).get(Date.now());
}

export async function runTask(db, id, ctx) {
  const { workerId, provider } = ctx;
  for (let step = 0; step < 60; step++) {
    const t = getTask(db, id);
    if (!t) return null;
    if (PAUSED.has(t.state)) return t;
    if (!renew(db, id, workerId, 300000)) {
      record(db, { taskId: id, type: "lease.lost", actor: workerId, payload: {} }, false);
      return getTask(db, id);
    }
    try {
      switch (t.state) {
        case "queued":      transition(db, id, "planning", { actor: workerId, reason: "claimed" }); break;
        case "planning":    await doPlanning(db, id, ctx); break;
        case "implementing":await doImplement(db, id, ctx); break;
        case "verifying":   await doVerify(db, id, ctx); break;
        case "reviewing":   await doReview(db, id, ctx); break;
        case "merging":     await doMerge(db, id, ctx); break;
        default: return t;
      }
    } catch (e) {
      const cur = getTask(db, id);
      const msg = String(e && e.message || e);
      addEvidence(db, id, { last_error: msg, at: new Date().toISOString() }, "evidence.patch");
      record(db, { taskId: id, type: "run.error", actor: workerId, payload: { state: cur && cur.state, error: msg.slice(0, 400) } }, false);
      if (cur && cur.state === "blocked") return cur; // 熔断后的状态不许被 catch 重新拉回队列
      // 计划和验证阶段的失败不会涨 attempts（没走到 implementing），
      // 只看 attempts 会让"每次调用都失败的引擎"无限重试、白烧时间。所以单独数错误。
      const errors = db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type='run.error'").get(id).n;
      if ((cur && cur.attempts >= MAX_ATTEMPTS) || errors >= MAX_ATTEMPTS * 2) {
        transition(db, id, "blocked", { actor: workerId, reason: "error(" + errors + "): " + msg.slice(0, 200) });
      } else {
        transition(db, id, "queued", { actor: workerId, reason: "retry after error" });
      }
      return getTask(db, id);
    }
  }
  return getTask(db, id);
}

async function callAgent(db, id, ctx, { role, prompt, attempt }) {
  const t = getTask(db, id);
  if (overBudget(t)) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "budget exhausted" });
    throw new Error("budget exhausted");
  }
  const timer = setInterval(() => renew(db, id, ctx.workerId, 300000), 60000);
  if (timer.unref) timer.unref();
  try {
    const zeroBased = attempt === undefined ? Math.max(0, t.attempts - 1) : attempt;
    const res = await ctx.provider.run({ role, prompt, cwd: ctx.cwd, task: t, attempt: zeroBased });
    if (res && res.tokens) spendBudget(db, id, res.tokens, { role });
    if (!res || !res.ok) throw new Error((role + " 调用失败: ") + (res && res.error || "unknown"));
    return res;
  } finally {
    clearInterval(timer);
  }
}

async function doPlanning(db, id, ctx) {
  const t = getTask(db, id);
  const lead = await callAgent(db, id, { ...ctx, cwd: ROOT }, { role: "lead", prompt: sop.leadPrompt(t) });
  const arch = await callAgent(db, id, { ...ctx, cwd: ROOT }, { role: "architect", prompt: sop.architectPrompt(t, lead.text) });
  record(db, { taskId: id, type: "plan.produced", actor: "architect", payload: { plan_md: arch.text } });
  record(db, { taskId: id, type: "slices.produced", actor: "lead", payload: { slices: lead.text } });
  transition(db, id, "implementing", { actor: ctx.workerId, reason: "plan ready" });
}

async function doImplement(db, id, ctx) {
  let t = getTask(db, id);
  const repo = resolve(ROOT, t.repo);
  if (!isGitRepo(repo)) throw new Error("目标不是 git 仓库: " + repo);

  if (t.attempts >= MAX_ATTEMPTS) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "max attempts reached" });
    return;
  }

  const base = t.base_sha || headSha(repo);
  const branch = t.branch || ("wb/" + id);
  const dir = join(WORKTREES, id);
  const wt = ensureWorktree({ repo, dir, branch, base });
  if (!wt.ok) throw new Error("worktree 失败: " + wt.error);

  // 崩溃续跑：上一次 attempt 没有产出 impl（进程被 kill -9），就不该白烧一次重试额度
  const inflight = hasInflightAttempt(db, id);
  const tries = db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id=? AND type IN ('attempt.started','attempt.resumed')").get(id).n;
  if (tries >= MAX_ATTEMPTS * 3) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "too many retries (incl. crash resumes)" });
    return;
  }
  record(db, {
    taskId: id,
    type: inflight ? "attempt.resumed" : "attempt.started",
    actor: ctx.workerId,
    payload: inflight ? { attempt: t.attempts - 1, reason: "resumed after crash" } : { attempt: t.attempts },
  });
  t = getTask(db, id);
  const attempt = t.attempts - 1;

  await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "coder",
    prompt: sop.coderPrompt(t, t.plan_md || "", attempt),
    attempt,
  });

  const c = commitAll(dir, "wb: " + t.title + " (attempt " + (attempt + 1) + ")");
  if (!c.ok) throw new Error("commit 失败: " + c.error);

  record(db, {
    taskId: id, type: "impl.produced", actor: "coder",
    payload: { diff_stat: diffStat(dir, base), branch, base_sha: base },
  });
  transition(db, id, "verifying", { actor: ctx.workerId, reason: "impl committed" });
}

async function doVerify(db, id, ctx) {
  const t = getTask(db, id);
  const dir = join(WORKTREES, id);
  const base = t.base_sha;
  if (!base || !isGitRepo(dir)) {
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "worktree/base missing" });
    return;
  }

  const cfg = loadRepoConfig(dir);
  const guards = runGuards({ workdir: dir, base, config: cfg });
  const diff = diffPatch(dir, base, 20000);

  const res = await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "verifier",
    prompt: sop.verifierPrompt({ task: t, diff, testOutput: guards.testOutput, guards }),
  });

  const v = sop.parseVerdict(res.text) || { verdict: guards.ok ? "pass" : "fail", summary: "未给出结构化结论，按护栏判定", raised: [] };
  const passed = guards.ok && v.verdict === "pass";

  addEvidence(db, id, {
    verify: {
      passed,
      guards: guards.checks,
      guardsFailed: guards.failed,
      testCmd: guards.testCmd,
      testOutputTail: guards.testOutput.slice(-3000),
      diff: String(diff || "").slice(0, 12000),
      verdict: v,
      at: new Date().toISOString(),
    },
  }, "verify.result");

  if (passed) {
    transition(db, id, "reviewing", { actor: ctx.workerId, reason: "verified" });
  } else if (t.attempts >= MAX_ATTEMPTS) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "verify failed: " + guards.failed.join(",") });
  } else {
    transition(db, id, "implementing", { actor: ctx.workerId, reason: "verify failed: " + guards.failed.join(",") });
  }
}

async function doReview(db, id, ctx) {
  const t = getTask(db, id);
  const dir = join(WORKTREES, id);
  const base = t.base_sha;
  const guards = { checks: (t.evidence && t.evidence.verify && t.evidence.verify.guards) || [], ok: true, failed: [] };
  const testOutput = (t.evidence && t.evidence.verify && t.evidence.verify.testOutputTail) || "";
  const diff = base ? diffPatch(dir, base, 12000) : "";

  const res = await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "reviewer",
    prompt: sop.reviewerPrompt({ task: t, plan: t.plan_md || "", diff, testOutput, guards }),
  });

  const v = sop.parseVerdict(res.text) || { verdict: "pass", summary: "未给出结构化结论", raised: [] };
  addEvidence(db, id, {
    review: { verdict: v, raised: v.raised || [], diffStat: t.diff_stat, at: new Date().toISOString() },
  }, "review.result");
  transition(db, id, "awaiting_human", { actor: ctx.workerId, reason: "ready for human" });
}

/** 上一次 attempt.started 之后没有 impl.produced，说明那次尝试没跑完（通常是崩溃）。 */
function hasInflightAttempt(db, id) {
  const s = db.prepare("SELECT COALESCE(MAX(id),0) AS i FROM events WHERE task_id=? AND type='attempt.started'").get(id).i;
  const c = db.prepare("SELECT COALESCE(MAX(id),0) AS i FROM events WHERE task_id=? AND type='impl.produced'").get(id).i;
  return s > c;
}

async function doMerge(db, id, ctx) {
  const t = getTask(db, id);
  const repo = resolve(ROOT, t.repo);
  const branch = t.branch || ("wb/" + id);
  const r = sh("git", ["-C", repo, "merge", "--no-ff", "-m", "wb: merge " + t.title, branch]);
  if (!r.ok) {
    addEvidence(db, id, { merge_error: String(r.out).slice(-2000) }, "evidence.patch");
    transition(db, id, "awaiting_human", { actor: ctx.workerId, reason: "merge conflict, needs human" });
    return;
  }
  record(db, { taskId: id, type: "merge.done", actor: ctx.workerId, payload: { sha: headSha(repo) } });
  transition(db, id, "done", { actor: ctx.workerId, reason: "merged" });
}

/** 主泵：认领 -> 跑到暂停点 -> 释放租约。可被 kill -9，重启后从状态机续跑。 */
export async function pump(db, { workerId, provider, once = false, idleMs = 1500, onTask } = {}) {
  for (;;) {
    reclaimDead(db);
    reclaimExpired(db);
    const cand = pickRunnable(db);
    if (!cand) {
      if (once) return null;
      await sleep(idleMs);
      continue;
    }
    if (!acquire(db, cand.id, workerId, 300000)) continue;
    try {
      const t = await runTask(db, cand.id, { workerId, provider, cwd: ROOT });
      if (onTask && t) onTask(t);
    } finally {
      release(db, cand.id, workerId, "yield");
    }
    if (once) return cand.id;
  }
}

async function main() {
  const db = openDb();
  const workerId = process.env.WB_WORKER_ID || (hostname() + ":" + process.pid);
  const engineName = process.env.WB_ENGINE || "mock";
  const provider = await getProvider(engineName);
  process.stdout.write("[worker] " + workerId + " engine=" + engineName + " root=" + ROOT + "\n");
  await pump(db, {
    workerId, provider,
    onTask: (t) => process.stdout.write("[worker] " + t.id + " -> " + t.state + " attempts=" + t.attempts + "\n"),
  });
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("worker.mjs");
if (invokedDirectly) {
  main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
}