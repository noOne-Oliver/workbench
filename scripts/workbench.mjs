#!/usr/bin/env node
/**
 * Web 版启动器：把工作台当成一个「本机/内网可访问的 Web 服务」跑起来。
 *
 *   node scripts/workbench.mjs start  [--port 7317] [--host 0.0.0.0] [--workspace ~/Workbench]
 *   node scripts/workbench.mjs stop | restart | status | logs [--follow]
 *
 * 它只做三件事：准备一个工作区、起 server + worker 两个后台进程、打印能直接点开的地址。
 * 进程与状态都落在 <workspace>/.wb/ 下（pid 文件 + 日志 + 口令），换机器/重启都能接着来。
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cmd = argv[0] || "start";
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : def;
};
const WS = resolve(opt("workspace", process.env.WB_WORKSPACE || join(homedir(), "Workbench")));
const PORT = Number(opt("port", process.env.WB_PORT || 7317));
const HOST = opt("host", process.env.WB_HOST || "0.0.0.0");
const ENGINE = opt("engine", process.env.WB_ENGINE || "mock");
const STATE = join(WS, ".wb");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pidFile = (name) => join(STATE, name + ".pid");
const logFile = (name) => join(STATE, name + ".log");
const tokenFile = join(STATE, "token");

function die(msg) {
  process.stderr.write("✗ " + msg + "\n");
  process.exit(1);
}

function alive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(name) {
  try {
    return Number(readFileSync(pidFile(name), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function readToken({ create = false } = {}) {
  if (process.env.WB_TOKEN) return process.env.WB_TOKEN;
  try {
    const t = readFileSync(tokenFile, "utf8").trim();
    if (t) return t;
  } catch {}
  if (!create) return "";
  const t = randomBytes(18).toString("base64url");
  writeFileSync(tokenFile, t, { mode: 0o600 });
  return t;
}

async function health() {
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/api/tasks", {
      headers: readToken() ? { "x-wb-token": readToken() } : {},
    });
    return r.ok;
  } catch {
    return false;
  }
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) out.push("http://" + i.address + ":" + PORT + "/");
    }
  }
  return out;
}

function childEnv(token) {
  return {
    ...process.env,
    WB_ROOT: WS,
    WB_CODE: ROOT,
    WB_DB: join(WS, "data", "ledger.db"),
    WB_OC_HOME: join(WS, ".oc"),
    WB_PORT: String(PORT),
    WB_HOST: HOST,
    WB_ENGINE: ENGINE,
    WB_TOKEN: token,
  };
}

function spawnDetached(name, args, env) {
  const out = openSync(logFile(name), "a");
  const p = spawn(process.execPath, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  p.unref();
  writeFileSync(pidFile(name), String(p.pid));
  return p.pid;
}

async function start() {
  const { ensureWorkspace } = await import("../src/core/workspace.mjs");
  mkdirSync(STATE, { recursive: true });
  const ws = ensureWorkspace(WS);
  const hadToken = (() => {
    try {
      return !!readFileSync(tokenFile, "utf8").trim();
    } catch {
      return false;
    }
  })();
  const token = readToken({ create: true });
  const fresh = !hadToken && !process.env.WB_TOKEN;

  if (await health()) {
    process.stdout.write("工作台已经在跑了（端口 " + PORT + "），没有重复启动。\n");
    return report(token, false);
  }
  if (readPid("server") && alive(readPid("server"))) {
    die("有 server 进程占着 " + pidFile("server") + " 但端口不响应，先 stop 再 start");
  }

  const env = childEnv(token);
  const serverPid = spawnDetached("server", [join(ROOT, "src/server/index.mjs")], env);
  const workerPid = spawnDetached("worker", [join(ROOT, "src/cli.mjs"), "run"], env);

  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await health()) return report(token, fresh, serverPid, workerPid, ws);
    if (!alive(serverPid)) break;
  }
  process.stderr.write(tail("server", 20));
  die("服务端起不来，日志 " + logFile("server"));
}

function report(token, fresh, serverPid = readPid("server"), workerPid = readPid("worker"), ws = WS) {
  const urls = ["http://127.0.0.1:" + PORT + "/", ...lanUrls()];
  process.stdout.write("\n✓ 工作台已启动\n");
  process.stdout.write("  工作区  " + (ws.root || ws) + "\n");
  process.stdout.write("  引擎    " + ENGINE + "\n");
  process.stdout.write("  进程    server=" + serverPid + " worker=" + workerPid + "\n");
  process.stdout.write("  日志    " + logFile("server") + " · " + logFile("worker") + "\n\n");
  process.stdout.write("  本机    " + urls[0] + "\n");
  for (const u of urls.slice(1)) process.stdout.write("  内网    " + u + "   （同一 Wi-Fi 下的人用这个）\n");
  process.stdout.write("\n  口令    " + (fresh ? token : "（已存在，见 " + tokenFile + "）") + "\n");
  if (fresh) process.stdout.write("          首次启动生成，git 里没有；发给同事后自己留一份\n");
  process.stdout.write("  停止    node scripts/workbench.mjs stop\n\n");
}

async function stop() {
  let stopped = 0;
  for (const name of ["worker", "server"]) {
    const pid = readPid(name);
    if (!alive(pid)) {
      rmSync(pidFile(name), { force: true });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(200);
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(pidFile(name), { force: true });
    stopped++;
  }
  process.stdout.write(stopped ? "✓ 已停止 " + stopped + " 个进程\n" : "· 没有在跑的进程\n");
}

function tail(name, lines = 40) {
  try {
    const all = readFileSync(logFile(name), "utf8").trimEnd().split("\n");
    return all.slice(-lines).join("\n") + "\n";
  } catch {
    return "(还没有日志)\n";
  }
}

async function status() {
  const portOpen = await health();
  const server = readPid("server");
  const worker = readPid("worker");
  process.stdout.write("工作区  " + WS + "\n");
  process.stdout.write("服务    端口 " + PORT + (portOpen ? " 可访问" : " 不通") + "（host " + HOST + "）\n");
  process.stdout.write("进程    server=" + (alive(server) ? server + " 在跑" : "没跑") + " worker=" + (alive(worker) ? worker + " 在跑" : "没跑") + "\n");
  if (portOpen) {
    const t = await (await fetch("http://127.0.0.1:" + PORT + "/api/tasks", { headers: { "x-wb-token": readToken() } })).json();
    const c = {};
    for (const x of t.tasks) c[x.state] = (c[x.state] || 0) + 1;
    process.stdout.write("任务    " + (t.tasks.length ? Object.entries(c).map(([k, v]) => k + " " + v).join(" · ") : "还没有任务") + "\n");
    for (const u of lanUrls()) process.stdout.write("内网    " + u + "\n");
  }
}

async function logs() {
  if (!argv.includes("--follow")) {
    process.stdout.write(tail("server") + tail("worker"));
    return;
  }
  const p = spawn("tail", ["-f", logFile("server"), logFile("worker")], { stdio: "inherit" });
  await new Promise((r) => p.once("exit", r));
}

async function freePortCheck() {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(PORT, "127.0.0.1");
  });
}

if (cmd === "start") {
  if (!(await freePortCheck())) {
    if (await health()) { process.stdout.write("工作台已经在跑了（端口 " + PORT + "）。\n"); await status(); }
    else die("端口 " + PORT + " 被别的程序占着：lsof -nP -i :" + PORT);
  } else {
    await start();
  }
} else if (cmd === "stop") await stop();
else if (cmd === "restart") { await stop(); await start(); }
else if (cmd === "status") await status();
else if (cmd === "logs") await logs();
else die("用法: workbench.mjs <start|stop|restart|status|logs> [--port 7317] [--workspace ~/Workbench]");
