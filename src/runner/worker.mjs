import { openDb } from "../core/db.mjs";
import { getTask, listTasks, transition, record, spendBudget, addEvidence, overBudget } from "../core/ledger.mjs";
import { acquire, renew, release, reclaimExpired } from "../core/lease.mjs";
import { getProvider } from "./engine.mjs";
import { sh, ensureWorktree, commitAll, diffStat, diffPatch, headSha, isGitRepo } from "./worktree.mjs";
import { loadRepoConfig, runGuards } from "./guards.mjs";
import * as sop from "./sop.mjs";
import { resolve, join } from "node:path";

import createMock from "./providers/mock.mjs";
import createOpencode from "./providers/opencode.mjs";
import { registerProvider } from "./engine.mjs";

registerProvider("mock", createMock);
registerProvider("opencode", createOpencode);

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
      addEvidence(db, id, { last_error: String(e && e.message || e), at: new Date().toISOString() }, "evidence.patch");
      if (cur && cur.attempts >= MAX_ATTEMPTS) {
        transition(db, id, "blocked", { actor: workerId, reason: "error: " + (e && e.message) });
      } else {
        transition(db, id, "queued", { actor: workerId, reason: "retry after error" });
      }
      return getTask(db, id);
    }
  }
  return getTask(db, id);
}

async function callAgent(db, id, ctx, { role, prompt }) {
  const t = getTask(db, id);
  if (overBudget(t)) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "budget exhausted" });
    throw new Error("budget exhausted");
  }
  const timer = setInterval(() => renew(db, id, ctx.workerId, 300000), 60000);
  if (timer.unref) timer.unref();
  try {
    const res = await ctx.provider.run({ role, prompt, cwd: ctx.cwd, task: t, attempt: t.attempts });
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

  record(db, { taskId: id, type: "attempt.started", actor: ctx.workerId, payload: { attempt: t.attempts } });
  t = getTask(db, id);
  const attempt = t.attempts - 1;

  await callAgent(db, id, { ...ctx, cwd: dir }, {
    role: "coder",
    prompt: sop.coderPrompt(t, t.plan_md || "", attempt),
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
  const workerId = process.env.WB_WORKER_ID || ("worker-" + process.pid);
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
