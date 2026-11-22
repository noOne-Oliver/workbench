#!/usr/bin/env node
/**
 * 打包复验：把 .app 当已安装的产物跑一遍真实链路。
 *
 *   node scripts/verify-package.mjs [--app dist/Workbench.app] [--port 7631] [--ws /tmp/wb-pkg-ws] [--keep]
 *
 * 断言四件事（任何一条不成立就 exit 2）：
 *   1. 脱离仓库也能起来：app 自己 spawn 内核，/api/workspace 的 code 指向包内 Resources/kernel；
 *   2. 工作区真的建在工作区目录里（不是 app 包内、也不是仓库）；
 *   3. worker 真的在跑：提交一个 mock 任务，能自动推进到 awaiting_human；
 *   4. 退出不留孤儿：SIGTERM 后端口关闭。
 */
import { spawn } from "node:child_process";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error("FAIL " + msg);
  process.exit(2);
}
async function api(path, init) {
  const r = await fetch("http://127.0.0.1:" + PORT + path, init);
  if (!r.ok) throw new Error(path + " → HTTP " + r.status);
  return r.json();
}

if (!existsSync(BIN)) fail("找不到 " + BIN + "（先跑 bash apps/macshell/build.sh）");
if (!KEEP) rmSync(WS, { recursive: true, force: true });
console.log("app=" + APP + "\nws=" + WS + "\nport=" + PORT);

const app = spawn(BIN, [], {
  cwd: "/tmp", // 故意离开仓库：证明不依赖当前目录
  env: { ...process.env, WB_WORKSPACE: WS, WB_PORT: String(PORT), WB_ENGINE: "mock" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
app.stdout.on("data", (d) => (out += d));
app.stderr.on("data", (d) => (out += d));
const stop = (sig) => { try { app.kill(sig); } catch {} };

try {
  // 1. 起来，且内核来自包内
  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    try { ws = await api("/api/workspace"); } catch {}
  }
  if (!ws) fail("30 秒内内核没起来；app 输出：\n" + out);

  console.log("workspace=" + JSON.stringify(ws));
  if (ws.code !== join(APP, "Contents/Resources/kernel")) fail("内核不是包内的：" + ws.code);
  if (ws.root !== WS) fail("工作区不对：期望 " + WS + "，实际 " + ws.root);
  if (!existsSync(join(WS, "demo", "package.json"))) fail("起始仓库没建出来：" + join(WS, "demo"));

  // 2. worker 在跑：提交一个任务，看它自己往前推
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
    if (["awaiting_human", "blocked", "done"].includes(task.state)) break;
  }
  console.log("states=" + seen.join(" → "));
  if (task.state !== "awaiting_human") fail("任务没跑到待裁决，停在 " + task.state + "：" + JSON.stringify(task.evidence));
  if (task.attempts < 1) fail("attempts=" + task.attempts + "，worker 好像没真跑");

  // 3. 退出干净
  stop("SIGTERM");
  await Promise.race([new Promise((r) => app.once("exit", r)), sleep(8000)]);
  let closed = false;
  for (let i = 0; i < 20 && !closed; i++) {
    await sleep(500);
    try { await api("/api/workspace"); } catch { closed = true; }
  }
  if (!closed) fail("SIGTERM 之后端口还开着（有孤儿进程）");
  if (app.exitCode === null) stop("SIGKILL");

  console.log("PASS 离仓可运行 / 工作区正确 / worker 真跑 / 退出无孤儿");
  console.log("task=" + id + " attempts=" + task.attempts + " spent=" + task.spent_tokens);
} catch (err) {
  stop("SIGKILL");
  fail(err.message);
}
