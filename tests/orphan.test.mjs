import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个「父进程」，跑 ms 毫秒后退出；返回它的 pid。 */
function fakeParent(ms) {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), " + ms + ")"], { stdio: "ignore" });
  return p;
}

test("父进程没了 → 看门狗主动收工（不留孤儿内核）", async () => {
  const parent = fakeParent(600);
  const child = spawn(
    process.execPath,
    ["-e", 'import("' + join(ROOT, "src/core/orphan.mjs") + '").then((m) => { m.watchParent({ intervalMs: 100, log: (s) => process.stderr.write("EXIT:" + s + "\\n") }); setInterval(() => {}, 1000); })'],
    { env: { ...process.env, WB_PARENT_PID: String(parent.pid) }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const started = Date.now();
  const code = await new Promise((r) => child.once("exit", r));
  const ms = Date.now() - started;
  assert.equal(code, 0, "主动收工应该是干净退出");
  assert.ok(ms < 8000, "父进程死后 8 秒内要退出，实际 " + ms + "ms");
  assert.match(err, /父进程 .* 已退出/, "要留一句可读的日志");
});

test("没有 WB_PARENT_PID 时不启用（手动从终端起不该自己退出）", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'import("' + join(ROOT, "src/core/orphan.mjs") + '").then((m) => { const t = m.watchParent({ intervalMs: 50 }); process.stderr.write(String(t === null)); setInterval(() => {}, 1000); })'],
    { env: { ...process.env, WB_PARENT_PID: "" }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await sleep(800);
  assert.equal(child.exitCode, null, "没有父进程约束时不该自己退出");
  assert.equal(err, "true", "watchParent 应返回 null 表示没启用");
  child.kill("SIGKILL");
});
