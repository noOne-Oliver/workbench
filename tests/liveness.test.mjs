import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeartbeat, readHeartbeat, STALE_MS } from "../src/core/liveness.mjs";
import { backoffMs, supervise, MAX_BACKOFF_MS } from "../src/core/supervisor.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "wb-live-"));

test("心跳写进去能被读到，并带 pid/engine", () => {
  const dir = tmp();
  const f = join(dir, "worker.json");
  const stop = startHeartbeat(f, { engine: "mock", workerId: "w1" }, 50);
  const h = readHeartbeat(f);
  stop();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(h.alive, true);
  assert.equal(h.pid, process.pid);
  assert.equal(h.engine, "mock");
  assert.equal(h.workerId, "w1");
  assert.ok(h.age_s <= 1);
});

test("没有心跳文件时判为不在线（而不是崩在这里）", () => {
  const h = readHeartbeat("/nonexistent/wb/worker.json");
  assert.equal(h.alive, false);
  assert.equal(h.age_s, null);
});

test("心跳过期就是断线：at 比 STALE_MS 还老", () => {
  const dir = tmp();
  const f = join(dir, "worker.json");
  writeFileSync(f, JSON.stringify({ pid: 1, at: Date.now() - STALE_MS - 5000 }));
  const h = readHeartbeat(f);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(h.alive, false);
  assert.ok(h.age_s >= STALE_MS / 1000);
  assert.equal(h.stale_after_s, Math.round(STALE_MS / 1000));
});

test("写坏了的心跳文件不让服务端 500", () => {
  const dir = tmp();
  const f = join(dir, "worker.json");
  writeFileSync(f, "{ 半截");
  assert.equal(readHeartbeat(f).alive, false);
  rmSync(dir, { recursive: true, force: true });
});

test("退避：1s 起，指数翻倍，封顶 30s", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(5), 16000);
  assert.equal(backoffMs(20), MAX_BACKOFF_MS);
  assert.equal(backoffMs(0), 1000);
});

function fakeChild() {
  const c = new EventEmitter();
  c.killed = 0;
  c.kill = () => { c.killed += 1; };
  return c;
}

test("看护：子进程退出后自动重启，并记录重启次数", async () => {
  const dir = tmp();
  // 快速退避，免得测试等 1s 起步
  const kids = [];
  const events = [];
  const sup = supervise(() => {
    const c = fakeChild();
    kids.push(c);
    return c;
  }, {
    onExit: (code, signal, s) => events.push({ code, signal, restarts: s.restarts, waitMs: s.waitMs }),
    log: () => {},
  });
  assert.equal(kids.length, 1);
  kids[0].emit("exit", 134, null);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(kids.length, 2, "应该在退避后起第二个");
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 134);
  assert.equal(events[0].restarts, 1);

  kids[1].emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 2900));
  assert.equal(kids.length, 3, "第二次退避 2s 后应起第三个");

  sup.stop();
  kids[2].emit("exit", 0, null);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(kids.length, 3, "stop 之后不该再重启");
  assert.equal(kids[2].killed, 1, "stop 应该给当前子进程发 SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});
