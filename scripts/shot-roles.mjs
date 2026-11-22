#!/usr/bin/env node
/**
 * 给「两段评审」界面留证据：准备一个 lead / member 都在场的工作区，截图 docs/roles-review.png。
 * 屏幕上的按钮就是权限矩阵本身——member 只看到初筛，lead 才看到批准并合并。
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const ROOT = resolve(import.meta.dirname, "..");
// 路径可配：公开仓库的截图要用中性路径（/tmp/...），不能带本机家目录
const WS = resolve(process.env.SHOT_WS || resolve(ROOT, ".demo/roles-ws"));
const PORT = Number(process.env.SHOT_PORT || 7794);
const CDP_PORT = Number(process.env.SHOT_CDP || 9339);
const BASE = "http://127.0.0.1:" + PORT;
const OUT = resolve(ROOT, "docs/roles-review.png");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(WS, { recursive: true, force: true });
const ws = ensureWorkspace(WS);

const server = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
  cwd: ROOT,
  // WB_WORKER_ID：默认身份是 hostname:pid，这台机器的 hostname 带用户名，会漏进活动流截图
  env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(PORT), WB_HOST: "127.0.0.1", WB_ADMIN_NAME: "lead0", WB_TOKEN: "", WB_WORKER_ID: "runner-1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvOut = "";
server.stdout.on("data", (d) => { srvOut += String(d); });
server.stderr.on("data", (d) => { srvOut += String(d); });

async function login(name, password) {
  const r = await fetch(BASE + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  if (r.status !== 200) throw new Error("登录失败 " + name + ": " + (await r.text()));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
const post = (cookie, path, body) => fetch(BASE + path, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
});
const getTask = async (cookie, id) => (await (await fetch(BASE + "/api/tasks/" + id, { headers: { cookie } })).json()).task;
const runOnce = () => new Promise((res) => {
  const c = spawn(process.execPath, [resolve(ROOT, "src/cli.mjs"), "run", "--once"], {
    cwd: ROOT, env: { ...process.env, WB_ROOT: WS, WB_ENGINE: "mock", WB_WORKER_ID: "runner-1" }, stdio: "ignore",
  });
  c.on("exit", res);
});
async function pump(cookie, id, want, max = 30) {
  for (let i = 0; i < max; i++) {
    const t = await getTask(cookie, id);
    if (want.includes(t.state)) return t;
    await runOnce();
  }
  throw new Error("没到 " + want.join("/"));
}

// ---- 1) 准备数据 ----
for (let i = 0; i < 80 && !/一次性口令: /.test(srvOut); i++) await sleep(100);
const bootPw = (srvOut.match(/一次性口令: (\S+)/) || [])[1];
if (!bootPw) throw new Error("服务没起来: " + srvOut.slice(0, 300));
const lead0 = await login("lead0", bootPw);
for (const [name, role] of [["alice", "member"], ["bob", "member"]]) {
  await post(lead0, "/api/users", { name, role, password: "wb-" + name + "-123" });
}
const alice = await login("alice", "wb-alice-123");
const bob = await login("bob", "wb-bob-123");

const t1 = (await (await post(alice, "/api/tasks", { title: "给 calc 加乘法与除零报错", repo: ws.starterRepo, budgetTokens: 2_000_000 })).json()).task;
const t2 = (await (await post(alice, "/api/tasks", { title: "给 calc 加平方根（负数报错）", repo: ws.starterRepo, budgetTokens: 2_000_000 })).json()).task;

await pump(lead0, t1.id, ["awaiting_review"]);
await pump(lead0, t2.id, ["awaiting_review"]);
await post(bob, "/api/tasks/" + t1.id + "/review", { action: "claim" });
await post(bob, "/api/tasks/" + t1.id + "/review", { action: "pass", note: "范围和描述一致，没跑偏" });
console.log("数据就绪:", t1.id, "=>", (await getTask(lead0, t1.id)).state, "|", t2.id, "=>", (await getTask(lead0, t2.id)).state);

// ---- 2) 用 lead 的身份截图 ----
const profile = "/tmp/wb-cdp-roles-" + process.pid;
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1446,1000", "--user-data-dir=" + profile,
  "--remote-debugging-port=" + CDP_PORT, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(150);
  try {
    const v = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json();
    wsUrl = v.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) throw new Error("Chrome 没起来");

const target = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/new?url=about:blank", { method: "PUT" })).json();
const sock = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
let seq = 0;
const pending = new Map();
sock.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); sock.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1446, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/login.html" });
await sleep(1200);
await evalJs(`document.getElementById("name").value = "lead0";
  document.getElementById("password").value = ${JSON.stringify(bootPw)};
  document.getElementById("login").requestSubmit(); "ok"`);

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  await sleep(200);
  ready = await evalJs(`location.pathname === "/" && !!document.querySelector(".cards .card")`).catch(() => false);
}
if (!ready) throw new Error("登录后没看到卡片：" + (await evalJs("location.href")));

const dom = await evalJs(`(() => {
  const cards = [...document.querySelectorAll(".cards .card")].map((c) => ({
    title: c.querySelector("h3")?.textContent,
    state: c.querySelector(".badge")?.textContent,
    buttons: [...c.querySelectorAll("button")].map((b) => b.textContent),
    owner: c.querySelector(".meta")?.textContent?.slice(0, 60),
  }));
  return { cards, who: document.getElementById("who")?.textContent, team: !!document.getElementById("team") };
})()`);
console.log(JSON.stringify(dom, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("shot=ok bytes=" + Buffer.from(shot.data, "base64").length + " -> " + OUT);

sock.close();
chrome.kill("SIGKILL");
server.kill("SIGTERM");
await sleep(300);
if (server.exitCode === null) server.kill("SIGKILL");
rmSync(profile, { recursive: true, force: true });
