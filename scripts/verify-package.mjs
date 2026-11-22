#!/usr/bin/env node
/**
 * 打包复验：把 .app 当已安装的产物跑一遍真实链路。
 *
 *   node scripts/verify-package.mjs [--app dist/Workbench.app] [--port 7631] [--ws /tmp/wb-pkg-ws] [--keep]
 *
 * 断言五件事（任何一条不成立就 exit 2）：
 *   1. 脱离仓库也能起来：app 自己 spawn 内核，/api/workspace 的 code 指向包内 Resources/kernel；
 *   2. 工作区真的建在工作区目录里（不是 app 包内、也不是仓库）；
 *   3. worker 真的在跑：提交一个 mock 任务，能自动推进到 awaiting_human；
 *   4. SIGTERM 退出干净：端口关闭；
 *   5. kill -9 之后也不留孤儿内核（靠 src/core/orphan.mjs 的父进程看门狗）。
 *
 * 端口被别人占着时直接失败（不会 attach 到上一次残留的内核上自欺欺人——这个坑实测踩过）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
};
const APP = resolve(opt("app", "dist/Workbench.app"));
const PORT = Number(opt("port", "7631"));
const WS = resolve(opt("ws", join(mkdtempSync(join(tmpdir(), "wb-pkg-")), "ws")));
const KEEP = args.includes("--keep");
const BIN = join(APP, "Contents/MacOS/Workbench");
// 新工作区会自动建 lead 账号（要登录），脚本用 token 走机器身份，避免每次都去日志里捞一次性口令。
const TOKEN = "wb-verify-" + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launched = [];
function fail(msg) {
  // 失败也要把起过的 app 收掉，否则残留内核会占着端口，下一次运行直接"端口被占用"（踩过）。
  for (const p of launched) { try { p.kill("SIGKILL"); } catch {} }
  console.error("FAIL " + msg);
  process.exit(2);
}
async function api(path, init) {
  const headers = { ...(init && init.headers), "x-wb-token": TOKEN };
  const r = await fetch("http://127.0.0.1:" + PORT + path, { ...init, headers });
  if (!r.ok) throw new Error(path + " → HTTP " + r.status);
  return r.json();
}
const portFree = () =>
  new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(PORT, "127.0.0.1");
  });
async function waitClosed(ms) {
  for (let i = 0; i < ms / 500; i++) {
    if (await portFree()) return true;
    await sleep(500);
  }
  return portFree();
}
function launch() {
  const p = spawn(BIN, [], {
    cwd: "/tmp", // 故意离开仓库：证明不依赖当前目录
    env: { ...process.env, WB_WORKSPACE: WS, WB_PORT: String(PORT), WB_ENGINE: "mock", WB_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.out = "";
  p.stdout.on("data", (d) => (p.out += d));
  p.stderr.on("data", (d) => (p.out += d));
  launched.push(p);
  return p;
}
const kill = (p, sig) => { try { p.kill(sig); } catch {} };

if (!existsSync(BIN)) fail("找不到 " + BIN + "（先跑 bash apps/macshell/build.sh）");
if (!(await portFree())) fail("端口 " + PORT + " 已被占用（八成是上次残留的内核）：lsof -nP -i :" + PORT + " 看一下，或换 --port");
if (!KEEP) rmSync(WS, { recursive: true, force: true });
console.log("app=" + APP + "\nws=" + WS + "\nport=" + PORT);

try {
  // ---- 第一段：起内核 → 建工作区 → 真跑一个任务 → SIGTERM 收工 ----
  const app = launch();
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    try { ws = await api("/api/workspace"); } catch {}
  }
  if (!ws) fail("30 秒内内核没起来；app 输出：\n" + app.out);

  console.log("workspace=" + JSON.stringify(ws));
  if (ws.code !== join(APP, "Contents/Resources/kernel")) fail("内核不是包内的：" + ws.code);
  if (ws.root !== WS) fail("工作区不对：期望 " + WS + "，实际 " + ws.root);
  if (!existsSync(join(WS, "demo", "package.json"))) fail("起始仓库没建出来：" + join(WS, "demo"));

  const created = await api("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "verify-package 自动任务", repo: join(WS, "demo"), owner: "verify-package", budgetTokens: 300000 }),
  });
  const id = created.task.id;
  const seen = [];
  let task = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const list = await api("/api/tasks");
    task = list.tasks.find((t) => t.id === id);
    if (!task) fail("任务消失了：" + id);
    if (seen[seen.length - 1] !== task.state) seen.push(task.state);
    // 现在有两段人工：awaiting_review（初筛）与 awaiting_approval（终审）；旧账本可能还是 awaiting_human。
    if (task.state.startsWith("awaiting_") || ["blocked", "done"].includes(task.state)) break;
  }
  console.log("states=" + seen.join(" → "));
  if (!task.state.startsWith("awaiting_")) fail("任务没跑到等人裁决，停在 " + task.state + "：" + JSON.stringify(task.evidence && task.evidence.verify));
  if (task.attempts < 1) fail("attempts=" + task.attempts + "，worker 好像没真跑");

  kill(app, "SIGTERM");
  await Promise.race([new Promise((r) => app.once("exit", r)), sleep(8000)]);
  if (!(await waitClosed(10000))) fail("SIGTERM 之后端口还开着（有孤儿进程）");
  console.log("SIGTERM：端口已关闭");

  // ---- 第二段：被 kill -9 时，内核也要自己收工（父进程看门狗） ----
  const app2 = launch();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500);
    try { await api("/api/tasks"); up = true; } catch {}
  }
  if (!up) fail("第二次启动没起来：" + app2.out);
  kill(app2, "SIGKILL");
  await Promise.race([new Promise((r) => app2.once("exit", r)), sleep(3000)]);
  const t0 = Date.now();
  if (!(await waitClosed(20000))) fail("kill -9 之后 20 秒端口还开着：内核成了孤儿（看 src/core/orphan.mjs 的 WB_PARENT_PID 有没有注入）");
  console.log("SIGKILL：" + ((Date.now() - t0) / 1000).toFixed(1) + " 秒后内核自己收工，没留孤儿");

  // ---- 第三段：worker 被杀掉后，看护要把它拉起来（执行器不能悄悄死掉） ----
  const app3 = launch();
  let h = null;
  for (let i = 0; i < 40 && !h; i++) {
    await sleep(500);
    try { h = await (await fetch("http://127.0.0.1:" + PORT + "/api/health")).json(); } catch {}
  }
  if (!h || !h.worker || !h.worker.alive) fail("健康接口没报出活着的 worker：" + JSON.stringify(h));
  const deadPid = h.worker.pid;
  try { process.kill(deadPid, "SIGKILL"); } catch (e) { fail("杀 worker 失败：" + e.message); }
  let revived = null;
  for (let i = 0; i < 30 && !revived; i++) {
    await sleep(1000);
    try {
      const x = await (await fetch("http://127.0.0.1:" + PORT + "/api/health")).json();
      if (x.worker && x.worker.alive && x.worker.pid !== deadPid) revived = x.worker;
    } catch {}
  }
  if (!revived) fail("worker 被杀掉后没被看护拉起来（看 src/core/supervisor.mjs）");
  console.log("watchdog：" + deadPid + " 被杀 → " + revived.pid + " 接管（" + revived.age_s + "s 前心跳）");
  kill(app3, "SIGTERM");
  await Promise.race([new Promise((r) => app3.once("exit", r)), sleep(8000)]);
  if (!(await waitClosed(10000))) fail("第三段 SIGTERM 之后端口还开着");

  console.log("PASS 离仓可运行 / 工作区正确 / worker 真跑 / SIGTERM 干净 / kill -9 无孤儿 / worker 崩了自愈");
  console.log("task=" + id + " attempts=" + task.attempts + " spent=" + task.spent_tokens);
} catch (err) {
  fail(err && err.message || String(err));
}
