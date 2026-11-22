import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.mjs";
import { createTask, getTask } from "../src/core/ledger.mjs";
import { readForTask } from "../src/core/events.mjs";
import { pump, pickRunnable, HANDLED_STATES } from "../src/runner/worker.mjs";

const mockProvider = { run: async () => ({ ok: true, text: "{}", tokens: 1, model: "mock" }) };

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "wb-stall-"));
  const db = openDb(join(dir, "ledger.db"));
  return { dir, db };
}

test("不认识的状态不会被反复认领：直接停到 blocked", async () => {
  const { dir, db } = freshDb();
  const t = createTask(db, { title: "老进程遇到新状态", repo: dir, owner: "me", budgetTokens: 1000 });
  // 模拟"状态机里没有的状态"（真实事故就是老内核遇到新状态，空转 2 小时写了 17GB）
  db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run("awaiting_new_stage", t.id);
  assert.ok(pickRunnable(db), "这种状态会被挑出来 —— 这正是危险点");

  await pump(db, { workerId: "t:1", provider: mockProvider, once: true });

  const after = getTask(db, t.id);
  assert.equal(after.state, "blocked");
  const evs = readForTask(db, t.id).map((e) => e.type);
  assert.ok(evs.includes("run.stalled"), "要留下 run.stalled 证据");
  assert.ok(!evs.includes("lease.acquired"), "不该先认领再空转");
  rmSync(dir, { recursive: true, force: true });
});

test("HANDLED_STATES 覆盖状态机里所有可执行状态", () => {
  for (const s of ["queued", "planning", "implementing", "verifying", "reviewing", "merging"]) {
    assert.ok(HANDLED_STATES.has(s), s + " 应该被执行器处理");
  }
  for (const s of ["awaiting_review", "awaiting_approval", "done", "blocked", "failed"]) {
    assert.ok(!HANDLED_STATES.has(s), s + " 不该被泵推进");
  }
});
