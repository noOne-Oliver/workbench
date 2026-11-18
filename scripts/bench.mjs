#!/usr/bin/env node
/**
 * 真引擎基准：把同一组代码任务丢给指定引擎，量「失败率 / 耗时 / token 成本 / 是否需要人兜底」。
 * 这是方案 1 的度量工具，先在内核里跑通闭环，才有数字可谈。
 *
 * 用法：
 *   node scripts/bench.mjs                     # 默认 mock，验证度量本身
 *   WB_ENGINE=opencode WB_MODEL=anthropic/claude-sonnet-4-5 node scripts/bench.mjs --tasks 3
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, ".bench/repo");
const DB = join(ROOT, "data/bench.db");

process.env.WB_DB = DB;
process.env.WB_ROOT = ROOT;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
};

/** 三个真实小任务：实现、加功能、修 bug。都带明确验收标准。 */
const SUITE = [
  {
    key: "slugify",
    title: "实现 src/slug.mjs 导出 slugify(s)：小写、非字母数字转 -、去首尾 -、连续 - 压成一个",
    accept: "node --test",
  },
  {
    key: "pow",
    title: "给 src/calc.mjs 增加 pow(a, b)，并在 test/calc.test.mjs 补对应测试",
    accept: "node --test",
  },
  {
    key: "divzero",
    title: "修 bug：calc(1, 0, '/') 现在返回 Infinity，应抛 Error('divide by zero')，并补测试",
    accept: "node --test",
  },
];

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

/** 一次性种子仓库：不依赖 sandbox/demo，保证基准可重复。 */
function ensureRepo() {
  if (existsSync(join(REPO, ".git"))) return;
  mkdirSync(join(REPO, "src"), { recursive: true });
  mkdirSync(join(REPO, "test"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "bench", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(join(REPO, "src/calc.mjs"), [
    "export function calc(a, b, op) {",
    "  if (op === '+') return a + b;",
    "  if (op === '-') return a - b;",
    "  if (op === '*') return a * b;",
    "  if (op === '/') return a / b;",
    "  throw new Error('unknown op: ' + op);",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(REPO, "test/calc.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "import { calc } from '../src/calc.mjs';",
    "",
    "test('add', () => assert.equal(calc(2, 3, '+'), 5));",
    "test('sub', () => assert.equal(calc(5, 3, '-'), 2));",
    "test('mul', () => assert.equal(calc(2, 3, '*'), 6));",
    "test('div', () => assert.equal(calc(6, 3, '/'), 2));",
    "",
  ].join("\n"));
  sh("git", ["init", "-q", "-b", "main"], REPO);
  sh("git", ["add", "-A"], REPO);
  sh("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-qm", "bench seed"], REPO);
}

const engineName = process.env.WB_ENGINE || "mock";
const model = process.env.WB_MODEL || "";
const limit = Number(arg("tasks", SUITE.length));
const budget = Number(arg("budget", 200000));

if (process.argv.includes("--fresh")) {
  for (const f of [DB, DB + "-wal", DB + "-shm"]) try { rmSync(f); } catch {}
}
ensureRepo();

const { openDb } = await import("../src/core/db.mjs");
const { createTask, getTask, listTasks } = await import("../src/core/ledger.mjs");
const { getProvider } = await import("../src/runner/engine.mjs");
await import("../src/runner/providers/index.mjs");
const { pump, ROOT: WROOT } = await import("../src/runner/worker.mjs");

const db = openDb(DB);
const provider = await getProvider(engineName, { model, home: join(ROOT, ".oc") });

console.log("[bench] engine=" + engineName + (model ? " model=" + model : "") + " tasks=" + limit + " db=" + DB);

const started = Date.now();
const ids = [];
for (const t of SUITE.slice(0, limit)) {
  const task = createTask(db, { title: t.title, repo: ".bench/repo", owner: "bench", budgetTokens: budget });
  ids.push({ id: task.id, key: t.key, title: t.title, accept: t.accept });
  console.log("[bench] enqueue " + task.id + " " + t.key);
}

// pump 默认是常驻循环；基准要的是「队列空了就收工」，所以一次一个地推
for (;;) {
  const picked = await pump(db, {
    workerId: "bench:" + process.pid,
    provider,
    once: true,
    onTask: (t) => console.log("[bench] " + t.id + " -> " + t.state + " attempts=" + t.attempts),
  });
  if (!picked) break;
}
const wallMs = Date.now() - started;

const rows = ids.map((x) => {
  const t = getTask(db, x.id);
  const evs = db.prepare("SELECT ts, type FROM events WHERE task_id=? ORDER BY id").all(x.id);
  const span = evs.length > 1 ? Math.round((Date.parse(evs[evs.length - 1].ts) - Date.parse(evs[0].ts)) / 1000) : 0;
  const ev = t.evidence || {};
  const verify = (ev.verify || {});
  return {
    id: x.id,
    key: x.key,
    state: t.state,
    attempts: t.attempts,
    spent: t.spent_tokens,
    budget: t.budget_tokens,
    seconds: span,
    verified: !!verify.passed,
    guardFails: (verify.guardsFailed || []).join(","),
    lastError: ev.last_error || "",
    title: x.title,
  };
});

const ok = rows.filter((r) => r.state === "awaiting_human" || r.state === "done");
const failed = rows.filter((r) => r.state === "blocked" || r.state === "failed");
const summary = {
  engine: engineName,
  model: model || null,
  at: new Date().toISOString(),
  wallSeconds: Math.round(wallMs / 1000),
  tasks: rows.length,
  reachedHuman: ok.length,
  blocked: failed.length,
  successRate: rows.length ? +(ok.length / rows.length).toFixed(2) : 0,
  totalTokens: rows.reduce((a, r) => a + r.spent, 0),
  avgSeconds: rows.length ? Math.round(rows.reduce((a, r) => a + r.seconds, 0) / rows.length) : 0,
  retries: rows.reduce((a, r) => a + Math.max(0, r.attempts - 1), 0),
};

console.log("");
console.log("任务                       状态             尝试  token      秒  校验");
for (const r of rows) {
  console.log([r.key.padEnd(10), r.state.padEnd(16), String(r.attempts).padStart(4), String(r.spent).padStart(8), String(r.seconds).padStart(5), r.verified ? "pass" : "FAIL"].join(" "));
  if (r.state === "blocked" || r.guardFails || r.lastError) console.log("   原因: " + (r.lastError || r.guardFails || "未知").slice(0, 200));
}
console.log("");
console.log("成功率 " + summary.successRate + "  到达人工审核 " + summary.reachedHuman + "/" + summary.tasks + "  重试 " + summary.retries + "  总 token " + summary.totalTokens + "  墙钟 " + summary.wallSeconds + "s");

const outDir = join(ROOT, "docs");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(outDir, "bench-" + engineName + "-" + stamp + ".json");
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log("报告: " + out);
process.exit(failed.length ? 2 : 0);