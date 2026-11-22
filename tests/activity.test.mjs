import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { createTask, transition, record } from "../src/core/ledger.mjs";
import { readForTask } from "../src/core/events.mjs";
import { feed, live, slimPayload } from "../src/core/activity.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "wb-act-"));
const freshDb = () => openDb(resolve(tmp(), "t.db"));
const payloadOf = (ev) => JSON.parse(ev.payload);
const VERDICT = String.fromCharCode(126).repeat(3) + "json\n" +
  JSON.stringify({ verdict: "pass", summary: "ok", raised: [] }) + "\n" + String.fromCharCode(126).repeat(3);

test("活动流：负载瘦身（不搬运 12KB diff）、带任务标题、增量游标、按任务过滤", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "实现乘法", repo: "/tmp/r", owner: "liujie", budgetTokens: 500 });
  record(db, {
    taskId: id, type: "verify.result", actor: "w",
    payload: { verify: { diff: "x".repeat(20000), guards: [1, 2, 3], passed: true } },
  });
  const all = feed(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].type, "task.created");
  assert.equal(all[1].title, "实现乘法", "每条事件都带任务标题，人看的是「哪个任务在干嘛」");
  assert.equal(all[1].payload.verify.diff.length, 201, "长正文截断到 200 字 + 省略号");
  assert.equal(all[1].payload.verify.guards, "3 项", "数组只报数量，不搬运内容");
  assert.equal(all[1].payload.verify.passed, true, "两层以内的标量要给界面用");

  const inc = feed(db, { since: all[0].id });
  assert.equal(inc.length, 1);
  assert.equal(inc[0].type, "verify.result");

  const { id: other } = createTask(db, { title: "另一个任务", repo: "/tmp/r", owner: "a" });
  record(db, { taskId: other, type: "agent.started", actor: "w", payload: { role: "lead" } });
  const only = feed(db, { task: other });
  assert.ok(only.every((e) => e.taskId === other));
  assert.equal(only.length, 2);
});

test("活动流：正在跑的角色、时长、静默超时判死", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a" });
  transition(db, id, "planning", { actor: "w" });
  record(db, { taskId: id, type: "agent.started", actor: "w", payload: { role: "lead", attempt: 0, prompt_chars: 1200 } });

  const now = Date.parse(new Date().toISOString()) + 5000;
  const running = live(db, now)[0];
  assert.equal(running.role, "lead");
  assert.ok(running.elapsed_s >= 4, "时长从 agent.started 算起");
  assert.equal(running.stalled, false);

  record(db, { taskId: id, type: "agent.heartbeat", actor: "w", payload: { role: "lead", elapsed_s: 15 } });
  assert.equal(live(db, now)[0].role, "lead", "心跳不该打断「正在跑」的判断");

  record(db, { taskId: id, type: "agent.finished", actor: "w", payload: { role: "lead", ok: true, tokens: 10, ms: 900 } });
  const idle = live(db, now)[0];
  assert.equal(idle.role, null, "跑完就不该再显示「正在跑」");
  assert.equal(idle.last_type, "agent.finished");

  assert.equal(live(db, now + 120000)[0].stalled, true, "60 秒无事件 = 进程多半已经死了");
});

test("活动流：slimPayload 处理字符串/数字/对象", () => {
  assert.deepEqual(slimPayload(JSON.stringify({ a: 1, b: true, c: null })), { a: 1, b: true, c: null });
  assert.equal(slimPayload(JSON.stringify({ s: "y".repeat(500) })).s.length, 201);
  assert.equal(slimPayload("不是 JSON").text, "不是 JSON");
  assert.deepEqual(slimPayload(null), {});
});

test("worker：每次 agent 调用都落 started/finished（带 token 与耗时），长调用期间有心跳", async () => {
  const root = tmp();
  process.env.WB_ROOT = root;
  process.env.WB_HEARTBEAT_MS = "20";
  const { pump } = await import("../src/runner/worker.mjs");
  const db = freshDb();
  // 标题带高危词 → 判 large，走完整的 lead + architect 两段（本用例测的是活动流，不是体量分级）
  const { id } = createTask(db, { title: "重构 calc 的运算符分支", repo: join(root, "no-repo"), owner: "a" });
  const provider = {
    run: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { ok: true, text: VERDICT, tokens: 1234 };
    },
  };
  await pump(db, { workerId: "w-test", provider, once: true });
  const evs = readForTask(db, id);
  const started = evs.filter((e) => e.type === "agent.started");
  assert.deepEqual(started.map((e) => payloadOf(e).role), ["lead", "architect"]);
  const finished = evs.filter((e) => e.type === "agent.finished");
  assert.equal(finished.length, 2);
  assert.equal(payloadOf(finished[0]).tokens, 1234);
  assert.ok(payloadOf(finished[0]).ms >= 60, "耗时是真实墙钟，不是 0");
  assert.ok(evs.some((e) => e.type === "agent.heartbeat"), "80ms 的调用 + 20ms 心跳，至少要有一条");
  delete process.env.WB_HEARTBEAT_MS;
});
