#!/usr/bin/env node
/**
 * 真引擎基准（两段评审版）：把一串小代码任务丢给真模型，量「一次过率 / token / 机器耗时 / 人工耗时」。
 *
 * 和 scripts/bench.mjs 的区别：那个只看机器能不能跑完，这个把两段人工也走完（bob 初筛 + lead0 终审），
 * 最后合进 main，所以能给出「这一单到底花多少、要人几次决策」的结论。
 *
 * 用法：
 *   WB_ENGINE=opencode WB_MODEL=gptagent/deepseek-v4.1-flash node scripts/bench-real.mjs --fresh --tasks 5
 *   node scripts/bench-real.mjs            # 默认 mock，验证度量本身（不烧钱）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASE_DIR = join(ROOT, ".bench-real");
const REPO = join(BASE_DIR, "repo");
const DB = join(ROOT, "data/bench-real.db");
const OC_HOME = process.env.WB_OC_HOME || join(ROOT, ".oc");

process.env.WB_DB = DB;
process.env.WB_ROOT = BASE_DIR;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
};

/** 五个独立小任务，覆盖「从零实现 / 加函数 / 修 bug / 边界条件 / 字符串处理」五类。 */
const SUITE = [
  {
    key: "slugify",
    title: "实现 src/text.mjs 导出 slugify(s)：转小写、非字母数字转 -、去首尾 -、连续 - 压成一个",
  },
  {
    key: "median",
    title: "实现 src/num.mjs 导出 median(nums)：偶数个取中间两数均值，空数组抛 Error('empty')",
  },
  {
    key: "range-bug",
    title: "修 bug：parseRange('5-3') 现在返回 [5,3]，应抛 Error('invalid range')，并补测试",
  },
  {
    key: "clamp",
    title: "给 src/num.mjs 加 clamp(n, min, max)（越界夹到边界，min>max 抛 Error('bad range')），并补测试",
  },
  {
    key: "truncate",
    title: "给 src/text.mjs 加 truncate(s, n)：超长截断并补 '…'（含省略号总长不超过 n），并补测试",
  },
];

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

/** 一次性种子仓库：三个模块各有「未实现」和一条基线测试，保证起点是绿的。 */
function ensureRepo() {
  if (existsSync(join(REPO, ".git"))) return;
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "test"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "bench-real", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(REPO, "src/text.mjs"), [
    "// 字符串工具。",
    "export function slugify(s) {",
    "  throw new Error(\"未实现\");",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(REPO, "src/num.mjs"), [
    "// 数值工具。",
    "export function median(nums) {",
    "  throw new Error(\"未实现\");",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(REPO, "src/range.mjs"), [
    "// 解析 \"1-5\" 这样的区间。",
    "export function parseRange(s) {",
    "  const [a, b] = String(s).split(\"-\").map(Number);",
    "  return [a, b];",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(REPO, "test/range.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "import { parseRange } from '../src/range.mjs';",
    "",
    "test('parse normal range', () => assert.deepEqual(parseRange('1-5'), [1, 5]));",
    "",
  ].join("\n"));
  sh("git", ["init", "-q", "-b", "main"], REPO);
  sh("git", ["add", "-A"], REPO);
  sh("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-qm", "bench-real seed"], REPO);
}

const engineName = process.env.WB_ENGINE || "mock";
const model = process.env.WB_MODEL || "";
const limit = Math.min(Number(arg("tasks", SUITE.length)), SUITE.length);
const budget = Number(arg("budget", process.env.WB_BUDGET || 1_500_000));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT = join(ROOT, "docs/bench-real-" + stamp + ".json");

if (process.argv.includes("--fresh")) {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) try { rmSync(f); } catch {}
  rmSync(REPO, { recursive: true, force: true });
}
ensureRepo();

const { openDb } = await import("../src/core/db.mjs");
const { createTask, getTask, record, transition } = await import("../src/core/ledger.mjs");
const { getProvider } = await import("../src/runner/engine.mjs");
await import("../src/runner/providers/index.mjs");
const { pump } = await import("../src/runner/worker.mjs");

const db = openDb(DB);
const provider = await getProvider(engineName, { model, home: OC_HOME });
const workerId = "bench-real:" + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("[bench-real] engine=" + engineName + (model ? " model=" + model : "") + " tasks=" + limit + " budget=" + budget);
console.log("[bench-real] db=" + DB + " repo=" + REPO);

/** 推到某个状态就停（模拟「机器干完了，等人」）。 */
async function pumpUntil(id, stop) {
  for (let i = 0; i < 200; i++) {
    const t = getTask(db, id);
    if (stop.includes(t.state)) return t;
    if (t.state === "blocked" || t.state === "failed") return t;
    await pump(db, { workerId, provider, once: true, onTask: () => {} });
    await sleep(50);
  }
  return getTask(db, id);
}

function activeSeconds(t) {
  const evs = db.prepare("SELECT ts FROM events WHERE task_id=? AND type IN ('attempt.started','agent.finished') ORDER BY id").all(t.id);
  return Math.round((Date.parse(evs[evs.length - 1].ts) - Date.parse(t.created_at)) / 1000);
}

const rows = [];
const totalStart = Date.now();

for (let i = 0; i < limit; i++) {
  const spec = SUITE[i];
  const task = createTask(db, { title: spec.title, repo: "repo", owner: "alice", budgetTokens: budget });
  const t0 = Date.now();
  console.log("\n[" + (i + 1) + "/" + limit + "] " + task.id + " " + spec.key);

  let t = await pumpUntil(task.id, ["awaiting_review", "done", "blocked", "failed"]);
  const machineSec = Math.round((Date.now() - t0) / 1000);
  console.log("  机器段: " + t.state + " attempts=" + t.attempts + " spent=" + t.spent_tokens + " (" + machineSec + "s)");

  let reviewSec = null;
  let approvalSec = null;
  if (t.state === "awaiting_review") {
    const tr = Date.now();
    record(db, { taskId: t.id, type: "review.claimed", actor: "bob", payload: { by: "bob", role: "member", note: "领取初筛", expires_at: Date.now() + 30 * 60 * 1000 } });
    record(db, { taskId: t.id, type: "review.passed", actor: "bob", payload: { by: "bob", role: "member", note: "实现和描述一致，护栏全绿", waived: false } });
    transition(db, t.id, "awaiting_approval", { actor: "bob", reason: "first review passed" });
    reviewSec = Math.max(1, Math.round((Date.now() - tr) / 1000));

    const ta = Date.now();
    record(db, { taskId: t.id, type: "human.decision", actor: "lead0", payload: { decision: "approved", note: "看过了，合", by: "lead0", role: "lead", self_approved: false, stage: "awaiting_approval" } });
    transition(db, t.id, "merging", { actor: "lead0", reason: "approved" });
    approvalSec = Math.max(1, Math.round((Date.now() - ta) / 1000));

    t = await pumpUntil(t.id, ["done", "blocked", "failed", "awaiting_approval"]);
    console.log("  人工段: 初筛 " + reviewSec + "s / 终审 " + approvalSec + "s -> " + t.state);
  }

  const ev = t.evidence || {};
  const guards = (ev.verify && ev.verify.guards) || [];
  const merge = db.prepare("SELECT payload FROM events WHERE task_id=? AND type='merge.done' ORDER BY id DESC LIMIT 1").get(t.id);
  const tc = (ev.verify && ev.verify.testCases) || {};
  rows.push({
    key: spec.key,
    id: t.id,
    title: spec.title,
    state: t.state,
    attempts: t.attempts,
    tokens: t.spent_tokens,
    machine_seconds: machineSec,
    review_seconds: reviewSec,
    approval_seconds: approvalSec,
    guards_pass: guards.filter((c) => c.ok).length + "/" + guards.length,
    tests: tc.total ?? 0,
    tests_failed: tc.fail ?? 0,
    diff_stat: t.diff_stat || (ev.verify && ev.verify.diff_stat) || null,
    merge_sha: merge ? JSON.parse(merge.payload).sha : null,
    error: t.last_error || null,
  });
  console.log("  结果: " + t.state + " token=" + t.spent_tokens + " 护栏=" + rows[i].guards_pass +
    " 用例=" + rows[i].tests + " diff=" + (rows[i].diff_stat || "-"));
}

const totalSec = Math.round((Date.now() - totalStart) / 1000);
const ok = rows.filter((r) => r.state === "done");
const summary = {
  engine: engineName,
  model: model || null,
  tasks: rows.length,
  done: ok.length,
  success_rate: rows.length ? Number((ok.length / rows.length).toFixed(3)) : 0,
  total_tokens: rows.reduce((s, r) => s + r.tokens, 0),
  avg_tokens: ok.length ? Math.round(ok.reduce((s, r) => s + r.tokens, 0) / ok.length) : 0,
  avg_machine_seconds: ok.length ? Math.round(ok.reduce((s, r) => s + r.machine_seconds, 0) / ok.length) : 0,
  total_seconds: totalSec,
  retried: rows.filter((r) => r.attempts > 1).length,
  human_decisions: ok.length * 2,
  tokens_by_role: db.prepare("SELECT payload FROM events WHERE type='budget.spent'").all().reduce((m, e) => {
    const p = JSON.parse(e.payload);
    const role = (p.detail && p.detail.role) || "?";
    m[role] = (m[role] || 0) + p.tokens;
    return m;
  }, {}),
  note: "review_seconds/approval_seconds 是脚本代劳的下限（人没真读），真实人工耗时见 docs/real-review 那单的 4 秒",
  rows,
};
writeFileSync(REPORT, JSON.stringify(summary, null, 2) + "\n");

console.log("\n=== 汇总 ===");
for (const r of rows) {
  console.log("  " + (r.state === "done" ? "PASS" : "FAIL") + "  " + r.key.padEnd(10) +
    " attempts=" + r.attempts + "  token=" + String(r.tokens).padStart(8) +
    "  机器=" + String(r.machine_seconds).padStart(4) + "s  人工=" + (r.review_seconds ?? "-") + "/" + (r.approval_seconds ?? "-") + "s" +
    "  护栏=" + r.guards_pass + (r.error ? "  err=" + String(r.error).slice(0, 120) : ""));
}
console.log("\n一次过率 " + (summary.success_rate * 100).toFixed(0) + "%  (" + summary.done + "/" + summary.tasks + ")" +
  "  平均 " + summary.avg_tokens + " token/单  平均机器 " + summary.avg_machine_seconds + "s  总墙钟 " + totalSec + "s");
console.log("报告 " + REPORT);
process.exit(ok.length === rows.length ? 0 : 2);
