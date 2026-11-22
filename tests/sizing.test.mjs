import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySize, repoFileCount } from "../src/core/sizing.mjs";

const task = (title) => ({ title });

test("单文件短标题走快路径", () => {
  const r = classifySize(task("实现 src/text.mjs 导出 slugify(s)：转小写、非字母数字转 -"));
  assert.equal(r.size, "small");
  assert.match(r.reason, /src\/text\.mjs/);
});

test("涉及多个文件要拆解", () => {
  const r = classifySize(task("把 src/a.mjs 和 src/b.mjs 的公共逻辑抽出来"));
  assert.equal(r.size, "normal");
  assert.match(r.reason, /2 个文件/);
});

test("标题过长说明需求本身没想清", () => {
  const r = classifySize(task("给 " + "x".repeat(130) + " 加个函数"));
  assert.equal(r.size, "normal");
  assert.match(r.reason, /\d+ 字/);
});

test("高危词直接走完整流水线", () => {
  for (const w of ["重构", "迁移", "并发", "性能"]) {
    const r = classifySize(task("把 calc 的 " + w + " 处理好"));
    assert.equal(r.size, "large", w + " 应判 large");
  }
});

test("仓库太大不省拆解", () => {
  const r = classifySize(task("实现 src/text.mjs 的 slugify"), { repoFiles: 41 });
  assert.equal(r.size, "large");
  assert.match(r.reason, /41 个文件/);
});

test("repoFileCount 只数被 git 跟踪的文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-size-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.mjs"), "export const a = 1;\n");
    writeFileSync(join(dir, "README.md"), "# hi\n");
    writeFileSync(join(dir, "ignored.txt"), "x\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "src/a.mjs", "README.md"], { cwd: dir });
    assert.equal(repoFileCount(dir), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不是 git 仓库时返回 0（交给后续报错，不在这里炸）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-size-"));
  try { assert.equal(repoFileCount(dir), 0); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("small 任务只花两次调用：跳过拆解与 Agent Reviewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-size-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/calc.mjs"), "export function calc() { throw new Error('未实现'); }\n");
  writeFileSync(join(repo, "test/calc.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert";\n\ntest("smoke", () => { assert.ok(true); });\n');
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });

  process.env.WB_ROOT = root;
  process.env.WB_MOCK_SCENARIO = "clean"; // 不要 fakegreen：这里要的是「一次就过」的省钱路径
  try {
    const { pump } = await import("../src/runner/worker.mjs");
    const { openDb } = await import("../src/core/db.mjs");
    const { createTask, getTask } = await import("../src/core/ledger.mjs");
    const createMock = (await import("../src/runner/providers/mock.mjs")).default;
    const db = openDb(join(root, "data/ledger.db"));
    const { id } = createTask(db, { title: "x", repo: "repo", owner: "a", budgetTokens: 1000000 });
    await pump(db, { workerId: "w-size", provider: await createMock(), once: true });

    const evs = db.prepare("SELECT type, payload FROM events WHERE task_id = ? ORDER BY id").all(id);
    const roles = evs.filter((e) => e.type === "agent.started").map((e) => JSON.parse(e.payload).role);
    assert.deepEqual(roles, ["coder", "verifier"], "小改动只该花两次调用，lead/architect/reviewer 都不该出现");
    assert.ok(evs.some((e) => e.type === "plan.skipped"), "跳过拆解要留痕");
    assert.ok(evs.some((e) => e.type === "review.skipped"), "跳过 Agent Reviewer 也要留痕");
    assert.equal(getTask(db, id).evidence.size, "small");
    assert.equal(getTask(db, id).state, "awaiting_review");
  } finally {
    delete process.env.WB_ROOT;
    delete process.env.WB_MOCK_SCENARIO;
    rmSync(root, { recursive: true, force: true });
  }
});