import { openDb } from "../core/db.mjs";
import { getTask, listTasks, transition, record, spendBudget, addEvidence, overBudget } from "../core/ledger.mjs";
import { acquire, renew, release, reclaimExpired, reclaimDead } from "../core/lease.mjs";
import { hostname } from "node:os";
import { getProvider } from "./engine.mjs";
import { sh, ensureWorktree, resetToBase, commitAll, diffStat, diffPatch, headSha, isGitRepo } from "./worktree.mjs";
import { loadRepoConfig, runGuards } from "./guards.mjs";
import * as sop from "./sop.mjs";
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";

import { BUILTIN_ENGINES } from "./providers/index.mjs";
export { BUILTIN_ENGINES };

export const ROOT = resolve(process.env.WB_ROOT || process.cwd());
const WORKTREES = resolve(ROOT, "worktrees");
const SCRATCH = resolve(ROOT, ".oc/scratch");
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
      // 确定性失败（权限/凭据/模型不存在）：重试是纯烧钱，直接交给人。
      if (e && e.fatal) {
        transition(db, id, "blocked", { actor: workerId, reason: msg.slice(0, 300) });
        return getTask(db, id);
      }
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

/**
 * 一次 agent 调用。
 * 人不在终端前面，所以"现在是谁在跑、跑了多久、有没有动静"必须落成事件：
 * agent.started / agent.heartbeat / agent.finished。没有这三条，界面只能给一个状态徽章，
 * 分不清"在思考"和"进程已经死了"——那正是值班员的活。
 */
async function callAgent(db, id, ctx, { role, prompt, attempt }) {
  const t = getTask(db, id);
  if (overBudget(t)) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: "budget exhausted" });
    throw new Error("budget exhausted");
  }
  const zeroBased = attempt === undefined ? Math.max(0, t.attempts - 1) : attempt;
  const startedMs = Date.now();
  record(db, {
    taskId: id, type: "agent.started", actor: ctx.workerId,
    payload: { role, attempt: zeroBased, prompt_chars: prompt.length },
  }, false);

  const timer = setInterval(() => renew(db, id, ctx.workerId, 300000), 60000);
  const beat = setInterval(() => {
    record(db, {
      taskId: id, type: "agent.heartbeat", actor: ctx.workerId,
      payload: { role, elapsed_s: Math.round((Date.now() - startedMs) / 1000) },
    }, false);
  }, Number(process.env.WB_HEARTBEAT_MS || 15000));
  if (timer.unref) timer.unref();
  if (beat.unref) beat.unref();

  let res = null;
  let thrown = null;
  try {
    res = await ctx.provider.run({ role, prompt, cwd: ctx.cwd, task: t, attempt: zeroBased });
    if (res && res.tokens) spendBudget(db, id, res.tokens, { role });
  } catch (e) {
    thrown = e;
  } finally {
    clearInterval(timer);
    clearInterval(beat);
  }

  record(db, {
    taskId: id, type: "agent.finished", actor: ctx.workerId,
    payload: {
      role,
      ok: !thrown && !!(res && res.ok),
      tokens: (res && res.tokens) || 0,
      ms: Date.now() - startedMs,
      error: thrown ? String(thrown && thrown.message || thrown).slice(0, 200)
        : (res && res.ok ? null : String(res && res.error || "unknown").slice(0, 200)),
    },
  }, false);

  if (thrown) throw thrown;
  if (!res || !res.ok) {
    const err = new Error((role + " 调用失败: ") + (res && res.error || "unknown"));
    // 引擎自己判定"再试也一样"的（权限、凭据、模型不存在），不该再烧掉五轮预算。
    err.fatal = !!(res && res.fatal);
    throw err;
  }
  return res;
}

/** 规划阶段的沙箱：真引擎会真的写文件，绝不能让 lead/architect 以仓库根为 cwd。 */
function scratchFor(id) {
  const d = join(SCRATCH, id);
  mkdirSync(d, { recursive: true });
  return d;
}

async function doPlanning(db, id, ctx) {
  const t = getTask(db, id);
  const dir = scratchFor(id);
  const repoAbs = resolve(ROOT, t.repo);
  const lead = await callAgent(db, id, { ...ctx, cwd: dir }, { role: "lead", prompt: sop.leadPrompt(t, repoAbs) });
  const arch = await callAgent(db, id, { ...ctx, cwd: dir }, { role: "architect", prompt: sop.architectPrompt(t, lead.text, repoAbs) });
  record(db, { taskId: id, type: "plan.produced", actor: "architect", payload: { plan_md: arch.text } });
  record(db, { taskId: id, type: "slices.produced", actor: "lead", payload: { slices: lead.text } });
  transition(db, id, "implementing", { actor: ctx.workerId, reason: "plan ready" });
}

/**
 * 预算里必须给"验证"留出余量。
 * 真实基准里翻过的车：实现花了 18 万 token 写完，账上没钱再跑一轮 Verifier，
 * 于是整个任务 blocked —— 那一轮实现的钱白花，人还得手动加预算重来。
 * 所以进入实现之前就检查：剩余预算够不够"再实现一次 + 验证一次"。
 */
export function reserveShort(task, ratio) {
  const budget = Number((task && task.budget_tokens) || 0);
  const spent = Number((task && task.spent_tokens) || 0);
  if (!budget) return "";
  const need = Math.max(budget * (ratio === undefined ? Number(process.env.WB_VERIFY_RESERVE || 0.25) : ratio), 150000);
  const left = budget - spent;
  if (left >= need) return "";
  return "预算不足：剩 " + left + "，实现+验证至少还要 " + Math.round(need) + "；加预算或人工接手";
}

/** 把上一轮验证失败的证据压成一段话，喂给重试的 Coder。没有失败则返回空串。 */
export function retryFeedback(task) {
  const v = (task && task.evidence && task.evidence.verify) || null;
  if (!v) return "";
  const failed = (v.guards || []).filter((c) => !c.ok);
  const lines = [];
  if (failed.length) {
    lines.push("机器护栏判定失败（这些是确定的，不是建议）：");
    for (const c of failed) lines.push("- " + c.id + "：" + c.detail);
  }
  const verdict = v.verdict || null;
  if (verdict && verdict.verdict === "fail" && verdict.summary) {
    lines.push("独立 Verifier 的结论：" + verdict.summary);
  }
  if (verdict && Array.isArray(verdict.raised) && verdict.raised.length) {
    lines.push("需要一并处理的点：" + verdict.raised.join("；"));
  }
  return lines.join("\n");
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

  // 真重试（不是崩溃续跑）必须从基线重来：否则 coder 看到的是上一轮已经写好的代码，
  // 会"发现活已干完"并产出逐字节相同的 diff，护栏照样不过 —— 白烧一整轮。
  if (!inflight && t.attempts > 0) {
    const reset = resetToBase(dir, base);
    if (!reset.ok) throw new Error("重置 worktree 到基线失败: " + reset.error);
  }

  // 预算要留出验证的钱：实现跑完却没钱验证，等于把上一轮的钱一起扔掉。
  const low = reserveShort(t);
  if (low) {
    transition(db, id, "blocked", { actor: ctx.workerId, reason: low });
    return;
  }
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
    prompt: sop.coderPrompt(t, t.plan_md || "", attempt, retryFeedback(t)),
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
      testCases: guards.testCases || null,
      baseline: guards.baseline || null,
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