#!/usr/bin/env node
/**
 * 真引擎整单跑两段评审：alice 提交 → 后台实现/验证 → 待初筛 → bob 领取并初筛通过
 * → lead0 终审批准 → 合并 → done。报告写 docs/real-review-<stamp>.json。
 *
 * 凭据从仓库 .oc 读（WB_OC_HOME），任务仓库与账本放独立工作区，别污染演示账本。
 * 用法：node scripts/demo-real-review.mjs [--fresh]
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WS = resolve(ROOT, ".demo/real-review-ws");
const PORT = Number(process.env.DEMO_PORT || 7795);
const BASE = "http://127.0.0.1:" + PORT;
const OC_HOME = process.env.WB_OC_HOME || resolve(ROOT, ".oc");
const ENGINE = process.env.WB_ENGINE || "opencode";
const MODEL = process.env.WB_MODEL || "gptagent/deepseek-v4.1-flash";
const BUDGET = Number(process.env.WB_BUDGET || 2_000_000);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT = resolve(ROOT, "docs/real-review-" + stamp + ".json");

if (process.argv.includes("--fresh")) rmSync(WS, { recursive: true, force: true });
const ws = ensureWorkspace(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const marks = {};

const childEnv = { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_OC_HOME: OC_HOME, WB_ENGINE: ENGINE, WB_MODEL: MODEL, WB_BUDGET: String(BUDGET) };
const server = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
  cwd: ROOT, env: { ...childEnv, WB_PORT: String(PORT), WB_HOST: "127.0.0.1", WB_ADMIN_NAME: "lead0", WB_TOKEN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvOut = "";
server.stdout.on("data", (d) => { srvOut += String(d); });
server.stderr.on("data", (d) => { srvOut += String(d); });

async function login(name, password) {
  const r = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password }),
  });
  if (r.status !== 200) throw new Error("登录失败 " + name + ": " + (await r.text()));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const post = (cookie, path, body) => fetch(BASE + path, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
});
const getTaskJson = async (cookie, id) => (await fetch(BASE + "/api/tasks/" + id, { headers: { cookie } })).json();
const getTask = async (cookie, id) => (await getTaskJson(cookie, id)).task;

function runOnce() {
  return new Promise((res) => {
    const c = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs"), "run", "--once"], {
      cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    c.stdout.on("data", (d) => { o += String(d); });
    c.stderr.on("data", (d) => { o += String(d); });
    c.on("exit", () => res(o));
  });
}

async function pump(cookie, id, want, max = 60) {
  for (let i = 0; i < max; i++) {
    const t = await getTask(cookie, id);
    if (want.includes(t.state)) return t;
    if (t.state === "blocked") return t;
    const before = t.state;
    const at = Date.now();
    const out = await runOnce();
    const after = await getTask(cookie, id);
    const secs = ((Date.now() - at) / 1000).toFixed(0);
    console.log("  [" + String(i + 1).padStart(2, "0") + "] " + before + " -> " + after.state +
      "  attempts=" + after.attempts + " spent=" + after.spent_tokens + " (" + secs + "s)");
    if (out.trim()) console.log("      " + out.trim().split("\n").slice(-3).join("\n      "));
    if (!marks[after.state]) marks[after.state] = { at_ms: Date.now() - t0, spent: after.spent_tokens };
  }
  throw new Error("等了 " + max + " 轮还没到 " + want.join("/"));
}

let report = null;
try {
  for (let i = 0; i < 120 && !/一次性口令: /.test(srvOut); i++) await sleep(100);
  const pw = (srvOut.match(/一次性口令: (\S+)/) || [])[1];
  if (!pw) throw new Error("服务没起来: " + srvOut.slice(0, 400));
  const lead0 = await login("lead0", pw);
  console.log("引擎", ENGINE, MODEL, "| 预算", BUDGET, "| 工作区", WS);

  for (const [name, role] of [["alice", "member"], ["bob", "member"]]) {
    const r = await post(lead0, "/api/users", { name, role, password: "wb-" + name + "-123" });
    if (r.status !== 201) console.log("  建人失败", name, r.status, await r.text());
  }
  const alice = await login("alice", "wb-alice-123");
  const bob = await login("bob", "wb-bob-123");

  const created = await (await post(alice, "/api/tasks", {
    title: "给 calc 加乘法、除法与除零报错", repo: ws.starterRepo, budgetTokens: BUDGET,
  })).json();
  const id = created.task.id;
  console.log("\n1) alice 提交", id, "owner=" + created.task.owner, "repo=" + ws.starterRepo);

  console.log("2) 真引擎推进（实现 → 验证 → 待初筛）");
  marks.submitted = { at_ms: 0 };
  let t = await pump(lead0, id, ["awaiting_review"]);
  if (t.state === "blocked") throw new Error("blocked: " + (t.last_error || "?"));

  console.log("3) bob 领取初筛");
  const claim = await (await post(bob, "/api/tasks/" + id + "/review", { action: "claim" })).json();
  console.log("   锁到", new Date(claim.task.review_lease_expires_at).toLocaleTimeString());
  await sleep(1500);
  const passed = await (await post(bob, "/api/tasks/" + id + "/review", { action: "pass", note: "实现和描述一致，测试真跑过" })).json();
  console.log("   初筛通过 ->", passed.task.state);

  console.log("4) lead0 终审批准");
  await sleep(1500);
  const approved = await (await post(lead0, "/api/tasks/" + id + "/review", { action: "approve", note: "看过了，合" })).json();
  console.log("   ->", approved.task.state);

  console.log("5) 合并");
  t = await pump(lead0, id, ["done", "blocked"], 10);
  const { events } = await getTaskJson(lead0, id);
  const ev = events.map((e) => ({ ...e, payload: typeof e.payload === "string" ? JSON.parse(e.payload || "{}") : e.payload }));
  const verify = ev.filter((e) => e.type === "evidence.patch").map((e) => e.payload.verify).filter(Boolean).pop() || {};
  const impl = ev.filter((e) => e.type === "impl.produced").pop();
  const reviewEv = ev.filter((e) => e.type.startsWith("review.")).map((e) => ({ type: e.type, actor: e.actor, at: e.ts, ...e.payload }));

  report = {
    engine: ENGINE, model: MODEL, task: id, state: t.state, attempts: t.attempts, spent_tokens: t.spent_tokens,
    budget: BUDGET, review_seconds: t.review_seconds, approval_seconds: t.approval_seconds,
    total_seconds: Math.round((Date.now() - t0) / 1000), marks,
    guard: verify.guard, verdict: verify.verdict, summary: verify.summary,
    diff_stat: impl && impl.payload ? impl.payload.diff_stat : null,
    review_events: reviewEv,
    events: ev.filter((e) => /^(task\.|review\.|human\.|attempt\.|run\.error|impl\.|plan\.|slices\.)/.test(e.type))
      .map((e) => ({ id: e.id, type: e.type, actor: e.actor, ts: e.ts, note: e.payload && e.payload.note || null })),
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n终态:", t.state, "| attempts=" + t.attempts, "| spent=" + t.spent_tokens,
    "| 初筛 " + t.review_seconds + "s | 终审 " + t.approval_seconds + "s | 总 " + report.total_seconds + "s");
  console.log("护栏:", JSON.stringify(verify.guard));
  console.log("Verifier:", verify.verdict, "-", verify.summary);
  console.log("diff:", report.diff_stat);
  console.log("报告:", REPORT);
  console.log(t.state === "done" ? "PASS" : "FAIL");
  process.exitCode = t.state === "done" ? 0 : 2;
} catch (e) {
  console.error("\n失败:", e.message);
  try {
    if (report) writeFileSync(REPORT, JSON.stringify({ ...report, error: e.message }, null, 2));
    const m = srvOut.match(/一次性口令: (\S+)/);
    if (m) {
      const lead0 = await login("lead0", m[1]);
      const { tasks } = await (await fetch(BASE + "/api/tasks", { headers: { cookie: lead0 } })).json();
      for (const t of tasks) console.error("  任务", t.id, t.state, "attempts=" + t.attempts, "spent=" + t.spent_tokens, "err=" + (t.last_error || ""));
    }
  } catch {}
  console.error("server log tail:\n" + srvOut.slice(-1500));
  process.exitCode = 2;
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  if (server.exitCode === null) server.kill("SIGKILL");
}
