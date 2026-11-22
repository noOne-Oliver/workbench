#!/usr/bin/env node
/**
 * 两段评审的端到端演示：提交 -> 机器验证 -> 待初筛 -> 成员领取/初筛通过 -> lead 终审批准 -> 合并。
 * 说明：人是两段，机器是一段；每段都要留下可审计的账本事件。
 *
 * 用法：node scripts/demo-review.mjs [--fresh]
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WS = resolve(ROOT, ".demo/review-ws");
const PORT = Number(process.env.DEMO_PORT || 7791);
const BASE = "http://127.0.0.1:" + PORT;

if (process.argv.includes("--fresh")) rmSync(WS, { recursive: true, force: true });
const ws = ensureWorkspace(WS);
console.log("工作区:", ws.root, "起始仓库:", ws.starterRepo);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
    cwd: ROOT,
    env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(PORT), WB_HOST: "127.0.0.1", WB_ADMIN_NAME: "lead0", WB_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const onData = (d) => { out += String(d); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return { child, out: () => out };
}

async function waitServer(out) {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (/一次性口令: (\S+)/.test(out())) return;
    try {
      const r = await fetch(BASE + "/api/workspace");
      if (r.status) return;
    } catch {}
  }
  throw new Error("服务没起来：" + out().slice(0, 500));
}

async function login(name, password) {
  const r = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  if (r.status !== 200) throw new Error("登录失败 " + name + ": " + r.status + " " + (await r.text()));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

/** 带会话的 GET：读任务详情（含事件）。 */
async function getTask(cookie, id) {
  const r = await fetch(BASE + "/api/tasks/" + id, { headers: { cookie } });
  return r.json();
}

function runOnce() {
  return new Promise((res) => {
    const c = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs"), "run", "--once"], {
      cwd: ROOT, env: { ...process.env, WB_ROOT: WS, WB_ENGINE: process.env.WB_ENGINE || "mock" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    c.stdout.on("data", (d) => { o += String(d); });
    c.stderr.on("data", (d) => { o += String(d); });
    c.on("exit", () => res(o));
  });
}

async function pumpUntil(cookie, id, want, max = 40) {
  for (let i = 0; i < max; i++) {
    const { task } = await getTask(cookie, id);
    if (want.includes(task.state)) return task;
    const before = task.state;
    await runOnce();
    const after = (await getTask(cookie, id)).task;
    console.log("  [" + String(i + 1).padStart(2, "0") + "] " + before + " -> " + after.state + "  attempts=" + after.attempts + " spent=" + after.spent_tokens);
  }
  throw new Error("等了 " + max + " 轮还没到 " + want.join("/"));
}

const t0 = Date.now();
const server = startServer();
try {
  await waitServer(server.out);
  const pw = server.out().match(/一次性口令: (\S+)/)[1];
  const lead0 = await login("lead0", pw);
  console.log("lead0 用一次性口令登录成功");

  // 建团队：两个 member、一个 viewer
  for (const [name, role] of [["alice", "member"], ["bob", "member"], ["carol", "viewer"]]) {
    const u = await (await fetch(BASE + "/api/users", {
      method: "POST", headers: { "content-type": "application/json", cookie: lead0 },
      body: JSON.stringify({ name, role, password: "wb-" + name + "-123" }),
    })).json();
    console.log("  成员已建:", u.user.name, u.user.role, u.password ? "(一次性口令 " + u.password + ")" : "");
  }

  const alice = await login("alice", "wb-alice-123");
  const bob = await login("bob", "wb-bob-123");
  const carol = await login("carol", "wb-carol-123");

  // 1) 成员提交任务
  const created = await (await fetch(BASE + "/api/tasks", {
    method: "POST", headers: { "content-type": "application/json", cookie: alice },
    body: JSON.stringify({ title: "给 calc 加乘法与除零报错", repo: ws.starterRepo, budgetTokens: 2_000_000 }),
  })).json();
  const id = created.task.id;
  console.log("\n1) alice 提交任务", id, "owner=" + created.task.owner);

  // 2) 机器跑完实现 + 验证，落到待初筛
  console.log("2) 后台推进（实现 -> 验证 -> 待初筛）");
  await pumpUntil(lead0, id, ["awaiting_review"]);

  // 3) 成员领取初筛
  console.log("3) 初筛");
  const claimed = await (await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: bob },
    body: JSON.stringify({ action: "claim" }),
  })).json();
  console.log("   bob 领取初筛，锁到", new Date(claimed.task.review_lease_expires_at).toLocaleTimeString());
  // 初筛是真要看的：留一点阅读时间，也顺带验证两段计时不是摆设
  await sleep(1200);

  // carol 是 viewer，不能领
  const forbidden = await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: carol },
    body: JSON.stringify({ action: "claim" }),
  });
  console.log("   carol(viewer) 想领 ->", forbidden.status, (await forbidden.json()).error);

  // 打回必须写理由
  const noNote = await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: bob },
    body: JSON.stringify({ action: "request_changes" }),
  });
  console.log("   不写理由打回 ->", noNote.status, (await noNote.json()).error);

  await (await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: bob },
    body: JSON.stringify({ action: "pass", note: "范围和描述一致，没跑偏" }),
  })).json();
  const afterFirst = (await getTask(lead0, id)).task;
  console.log("   bob 初筛通过 ->", afterFirst.state, "初筛耗时", afterFirst.review_seconds + "s");

  // member 不能终审
  const noApprove = await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: bob },
    body: JSON.stringify({ action: "approve", note: "我就要合" }),
  });
  console.log("   bob(member) 想批准 ->", noApprove.status, (await noApprove.json()).error);

  // 4) lead 终审（先留出读 diff 的时间）
  await sleep(1200);
  await (await fetch(BASE + "/api/tasks/" + id + "/review", {
    method: "POST", headers: { "content-type": "application/json", cookie: lead0 },
    body: JSON.stringify({ action: "approve", note: "看过了，合" }),
  })).json();
  console.log("4) lead0 批准 -> merging");

  // 5) 合并
  await pumpUntil(lead0, id, ["done", "blocked"], 8);
  const done = (await getTask(lead0, id)).task;
  console.log("5) 终态:", done.state, "| 初筛", done.review_seconds + "s", "| 终审", done.approval_seconds + "s", "| 总", ((Date.now() - t0) / 1000).toFixed(0) + "s");

  const { events } = await getTask(lead0, id);
  console.log("\n账本时间线（人看的部分）:");
  for (const e of events) {
    if (!/^(task\.|review\.|human\.|attempt\.|run\.|budget)/.test(e.type)) continue;
    const p = typeof e.payload === "string" ? JSON.parse(e.payload || "{}") : (e.payload || {});
    const note = p.note ? "  「" + p.note + "」" : "";
    console.log("  " + String(e.id).padStart(3) + " " + e.type.padEnd(22) + (e.actor || "-") + note);
  }

  const ok = done.state === "done" && afterFirst.state === "awaiting_approval";
  console.log("\n" + (ok ? "PASS" : "FAIL") + " 两段评审闭环");
  process.exitCode = ok ? 0 : 2;
} finally {
  server.child.kill("SIGTERM");
  await sleep(400);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}
