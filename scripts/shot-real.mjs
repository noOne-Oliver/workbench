#!/usr/bin/env node
/**
 * 给真引擎跑出来的工作区留证据：起服务 -> 用指定账号登录 -> 截图 + 打印 DOM 断言。
 * 用法：WB_ROOT=<工作区> SHOT_USER=lead0 SHOT_PASSWORD=<口令> SHOT_OUT=docs/real-review-ui.png node scripts/shot-real.mjs
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WS = resolve(process.env.WB_ROOT || resolve(ROOT, ".demo/real-review-ws"));
const PORT = Number(process.env.SHOT_PORT || 7796);
const CDP_PORT = Number(process.env.SHOT_CDP || 9341);
const BASE = "http://127.0.0.1:" + PORT;
const OUT = resolve(ROOT, process.env.SHOT_OUT || "docs/real-review-ui.png");
const USER = process.env.SHOT_USER || "lead0";
const PASSWORD = process.env.SHOT_PASSWORD;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PASSWORD) throw new Error("需要 SHOT_PASSWORD");

const server = spawn(process.execPath, [resolve(ROOT, "src/server/index.mjs")], {
  cwd: ROOT,
  env: { ...process.env, WB_ROOT: WS, WB_CODE: ROOT, WB_PORT: String(PORT), WB_HOST: "127.0.0.1", WB_TOKEN: "" },
  stdio: "ignore",
});
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad", "--disable-crash-reporter",
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1446,1000", "--user-data-dir=/tmp/wb-cdp-real-" + process.pid,
  "--remote-debugging-port=" + CDP_PORT, "about:blank",
], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(150);
  try { wsUrl = (await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json()).webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) throw new Error("Chrome 没起来");
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(BASE + "/api/workspace")).status) break; } catch { await sleep(100); }
}

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1446, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/login.html" });
await sleep(1200);
await evalJs(`document.getElementById("name").value = ${JSON.stringify(USER)};
  document.getElementById("password").value = ${JSON.stringify(PASSWORD)};
  document.getElementById("login").requestSubmit(); "ok"`);

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  await sleep(200);
  ready = await evalJs(`location.pathname === "/" && !!document.querySelector(".cards .card")`).catch(() => false);
}
if (!ready) throw new Error("登录后没看到卡片: " + (await evalJs("location.href")));

const dom = await evalJs(`(() => ({
  who: document.getElementById("who")?.textContent,
  cards: [...document.querySelectorAll(".cards .card")].map((c) => ({
    title: c.querySelector("h3")?.textContent,
    state: c.querySelector(".badge")?.textContent,
    text: c.innerText.replace(/\\s+/g, " ").slice(0, 260),
  })),
  events: document.querySelectorAll("#events li").length,
  live: document.getElementById("n-act")?.textContent,
}))()`);
console.log(JSON.stringify(dom, null, 2));

// 公开仓库的截图不能带本机痕迹：家目录、用户名、带用户名的主机名。
// 截图前先断言，脏图宁可不产出（比事后逐张 OCR 可靠得多）。
const leak = await evalJs(`(() => {
  const text = document.body.innerText || "";
  const needles = ["/Users/", "liujie"];
  const hit = needles.filter((n) => text.includes(n));
  return { hit, composeOpen: document.getElementById("compose-box")?.open === true };
})()`);
if (leak.hit.length || leak.composeOpen) {
  throw new Error("截图里有本机痕迹，拒绝写文件: " + JSON.stringify(leak));
}

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("shot=ok bytes=" + Buffer.from(shot.data, "base64").length + " -> " + OUT);

sock.close();
chrome.kill("SIGKILL");
server.kill("SIGTERM");
await sleep(300);
if (server.exitCode === null) server.kill("SIGKILL");
rmSync("/tmp/wb-cdp-real-" + process.pid, { recursive: true, force: true });
