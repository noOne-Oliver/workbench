import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 单独一个文件：worker.mjs 的 ROOT 是模块级常量（WB_ROOT 在 import 时求值），
// 所以「换一个临时仓库」必须是新进程，同文件里塞第二个用例会拿到上一个已删的目录。
test("降级路径：small 第一次没过 → 重试自动补方案与 reviewer（省钱不省第二次机会）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-downgrade-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/calc.mjs"), "export function calc() { throw new Error(\"未实现\"); }\n");
  writeFileSync(join(repo, "test/calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert";',
    '',
    'test("a", () => assert.equal(1, 1));',
    'test("b", () => assert.equal(2, 2));',
    "",
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });

  process.env.WB_ROOT = root;
  process.env.WB_MOCK_SCENARIO = "fakegreen"; // 第一次交伪绿：削弱既有测试 → 护栏打回 → 重试
  try {
    const { pump } = await import("../src/runner/worker.mjs");
    const { openDb } = await import("../src/core/db.mjs");
    const { createTask, getTask } = await import("../src/core/ledger.mjs");
    const createMock = (await import("../src/runner/providers/mock.mjs")).default;
    const db = openDb(join(root, "data/ledger.db"));
    const { id } = createTask(db, { title: "x", repo: "repo", owner: "a", budgetTokens: 1000000 });
    await pump(db, { workerId: "w-downgrade", provider: await createMock(), once: true });

    const evs = db.prepare("SELECT type, payload FROM events WHERE task_id = ? ORDER BY id").all(id);
    const roles = evs.filter((e) => e.type === "agent.started").map((e) => JSON.parse(e.payload).role);
    const t = getTask(db, id);
    assert.equal(t.attempts, 2);
    assert.deepEqual(roles, ["coder", "verifier", "lead", "coder", "verifier", "reviewer"],
      "第一次省钱走快路径；被打回后必须补上 lead 方案与 reviewer，不能一路省到底");
    assert.ok(evs.some((e) => e.type === "plan.skipped"), "第一次确实省了");
    assert.ok(evs.some((e) => e.type === "plan.produced"), "重试拿到真方案");
    assert.ok(!evs.some((e) => e.type === "slices.produced"), "normal 不该为切片再花一次调用");
    assert.equal(t.evidence.review.skipped, undefined, "被打回过的版本要过 reviewer");
    assert.equal(t.state, "awaiting_review");
  } finally {
    delete process.env.WB_ROOT;
    delete process.env.WB_MOCK_SCENARIO;
    rmSync(root, { recursive: true, force: true });
  }
});
