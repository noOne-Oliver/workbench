import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

import { openDb } from "../src/core/db.mjs";
import { record, createTask, getTask, transition, addEvidence, spendBudget, rebuild, overBudget } from "../src/core/ledger.mjs";
import { acquire, renew, release, reclaimExpired } from "../src/core/lease.mjs";
import { runGuards } from "../src/runner/guards.mjs";
import { parseVerdict } from "../src/runner/sop.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "wb-test-"));
const freshDb = () => openDb(resolve(tmp(), "t.db"));

test("状态机：合法迁移生效，非法迁移被拒", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a" });
  assert.equal(getTask(db, id).state, "queued");
  transition(db, id, "planning", { actor: "t" });
  assert.equal(getTask(db, id).state, "planning");
  // queued -> verifying 非法
  const { id: id2 } = createTask(db, { title: "y", repo: "/tmp/r", owner: "a" });
  assert.throws(() => transition(db, id2, "verifying", { actor: "t" }), /非法迁移/);
  // 同态幂等
  transition(db, id, "planning", { actor: "t" });
  assert.equal(getTask(db, id).state, "planning");
});

test("账本：rebuild 从事件全量重放，结果与投影一致", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a", budgetTokens: 1000 });
  transition(db, id, "planning", { actor: "t" });
  addEvidence(db, id, { verifier: { verdict: "pass" } }, "evidence.patch", "v");
  spendBudget(db, id, 10, "attempt 0");
  record(db, { taskId: id, type: "attempt.started", actor: "w", payload: { attempt: 0 } });

  const before = getTask(db, id);
  db.exec("DELETE FROM tasks");
  rebuild(db);
  const after = getTask(db, id);
  assert.equal(after.state, before.state);
  assert.equal(after.attempts, before.attempts);
  assert.equal(after.spent_tokens, before.spent_tokens);
});

test("租约：CAS 互斥、续租、释放后可抢占、过期可回收", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a" });
  assert.equal(acquire(db, id, "w1", 5000), true);
  assert.equal(acquire(db, id, "w2", 5000), false, "同一任务不能被第二个 worker 抢占");
  assert.equal(renew(db, id, "w2", 5000), false, "非持有者不能续租");
  assert.equal(renew(db, id, "w1", 5000), true);
  release(db, id, "w1");
  assert.equal(acquire(db, id, "w2", 5000), true);

  // 过期回收
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(Date.now() - 1000, id);
  assert.equal(reclaimExpired(db).length, 1);
  assert.equal(getTask(db, id).lease_owner, null);
});

test("预算：超限标记 overBudget，且不再放行", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a", budgetTokens: 100 });
  spendBudget(db, id, 60, "attempt 0");
  assert.equal(overBudget(getTask(db, id)), false);
  spendBudget(db, id, 60, "attempt 0");
  assert.equal(overBudget(getTask(db, id)), true);
  assert.equal(getTask(db, id).spent_tokens, 120);
});

test("Verifier 结论解析：兼容两种围栏与缺字段", () => {
  const a = parseVerdict('前言\n```json\n{"verdict":"pass","reason":"ok"}\n```');
  assert.equal(a.verdict, "pass");
  const b = parseVerdict('~~~json\n{"verdict":"fail","reason":"伪绿"}\n~~~');
  assert.equal(b.verdict, "fail");
  assert.equal(b.reason, "伪绿");
  const c = parseVerdict("没有任何 json");
  assert.equal(c, null, "解析不了时返回 null，由调用方兜底");
});

test("护栏：伪绿（削弱既有测试）被判 fail，正常加强判 pass", () => {
  const repo = tmp();
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/calc.mjs"), "export const add=(a,b)=>a+b;\n");
  writeFileSync(join(repo, "test/calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/calc.mjs";',
    'test("a", () => { assert.equal(add(1,2), 3); });',
    'test("b", () => { assert.equal(add(2,2), 4); assert.equal(add(0,0), 0); });',
  ].join("\n"));
  sh("git", ["init", "-q"]);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const baseSha = sh("git", ["rev-parse", "HEAD"]).trim();

  // 伪绿：把既有测试改用例数和断言数
  writeFileSync(join(repo, "test/calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("a", () => { assert.ok(true); });',
  ].join("\n"));
  const chk = (g, id) => g.checks.find((c) => c.id === id);
  const commit = (msg) => {
    sh("git", ["add", "-A"]);
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg]);
  };
  commit("伪绿");
  const bad = runGuards({ workdir: repo, base: baseSha });
  assert.equal(chk(bad, "tests_pass").ok, true, "测试本身是绿的");
  assert.equal(chk(bad, "no_test_weakening").ok, false, "但测试被削弱，护栏必须抓住");

  // 正当加强：追加用例
  writeFileSync(join(repo, "test/calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/calc.mjs";',
    'test("a", () => { assert.equal(add(1,2), 3); });',
    'test("b", () => { assert.equal(add(2,2), 4); assert.equal(add(0,0), 0); });',
    'test("负数", () => { assert.equal(add(-1,-2), -3); });',
  ].join("\n"));
  commit("加强测试");
  const good = runGuards({ workdir: repo, base: baseSha });
  assert.equal(chk(good, "tests_pass").ok, true);
  assert.equal(chk(good, "no_test_weakening").ok, true);
  assert.equal(good.ok, true, "正当加强应整体通过");
});
// 人打回 = 重新开局，不该吃掉机器人的重试额度。
// 否则人 reject 两次就把 attempts 顶到 MAX_ATTEMPTS，机器直接 blocked —— 人明明刚让它重做。
test("人打回不吃机器重试额度（attempts 归零）", () => {
  const db = freshDb();
  const { id } = createTask(db, { title: "x", repo: "/tmp/r", owner: "a" });
  record(db, { taskId: id, type: "attempt.started", actor: "w", payload: { attempt: 0 } });
  record(db, { taskId: id, type: "attempt.started", actor: "w", payload: { attempt: 1 } });
  assert.equal(getTask(db, id).attempts, 2);
  record(db, { taskId: id, type: "attempt.reset", actor: "a", payload: { reason: "human reject" } });
  assert.equal(getTask(db, id).attempts, 0, "人 reject 后应允许机器重新跑满 MAX_ATTEMPTS");
});

