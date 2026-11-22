import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实基准里撞到的事：coder 顺着 worktree 的 .git 找到主仓库，把测试文件写到主仓库里，
// 于是主仓库变脏 → merge 被 git 拒掉 → 任务卡在 awaiting_approval，人看到的只是一句
// "merge conflict, needs human"，完全不知道是自己仓库脏了。
// 这里的规矩：coder 越界写的东西必须被确定性收回（且只收回它写脏的那几个路径），
// 合并前主仓库不干净就直接 blocked 说清哪几个文件，而不是让 git 甩黑话。
test("coder 写到 worktree 外面 → 自动还原主仓库；别人的未提交改动一个字都不碰", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-contain-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "src/calc.mjs"), "export function add() { throw new Error(\"未实现\"); }\n");
  writeFileSync(join(repo, "test/base.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert";',
    "",
    'test("base", () => assert.equal(1, 1));',
    "",
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });

  // 人在主仓库里还有没提交的改动：这不是 coder 弄脏的，谁都不许动。
  writeFileSync(join(repo, "notes.txt"), "人写的草稿，别动\n");

  process.env.WB_ROOT = root;
  try {
    const { pump } = await import("../src/runner/worker.mjs");
    const { openDb } = await import("../src/core/db.mjs");
    const { createTask, getTask, record, transition } = await import("../src/core/ledger.mjs");
    const { statusPorcelain } = await import("../src/runner/worktree.mjs");
    const db = openDb(join(root, "data/ledger.db"));

    const tick = String.fromCharCode(96).repeat(3);
    const verdict = (v, s) => "完成。\n\n" + tick + "json\n" + JSON.stringify({ verdict: v, summary: s, raised: [] }) + "\n" + tick + "\n";

    let escapes = 0;
    const provider = {
      name: "escape",
      async run({ role, cwd }) {
        if (role === "lead") return { ok: true, tokens: 10, text: "1. 实现 add（验收：npm test）" };
        if (role === "coder") {
          // 该写的地方：自己的 worktree
          writeFileSync(join(cwd, "src/calc.mjs"), "export function add(a, b) { return a + b; }\n");
          mkdirSync(join(cwd, "test"), { recursive: true });
          writeFileSync(join(cwd, "test/add.test.mjs"), [
            'import test from "node:test";',
            'import assert from "node:assert";',
            'import { add } from "../src/calc.mjs";',
            "",
            'test("add", () => assert.equal(add(2, 3), 5));',
            'test("add negative", () => assert.equal(add(-2, -3), -5));',
            "",
          ].join("\n"));
          // 越界：顺手往主仓库里写一个新文件 + 改一个跟踪文件
          escapes += 1;
          writeFileSync(join(repo, "test/escaped.test.mjs"), "// 写错地方了\n");
          writeFileSync(join(repo, "src/calc.mjs"), "export function add() { return 42; }\n");
          return { ok: true, tokens: 30, text: "实现完成。" };
        }
        if (role === "verifier") return { ok: true, tokens: 10, text: verdict("pass", "add 正确，边界已覆盖。") };
        if (role === "reviewer") return { ok: true, tokens: 10, text: verdict("pass", "证据充分。") };
        return { ok: false, error: "unknown role: " + role };
      },
    };

    const a = createTask(db, { title: "实现 add", repo: "repo", owner: "alice", budgetTokens: 1000000 });
    for (let i = 0; i < 8; i++) {
      await pump(db, { workerId: "w-contain", provider, once: true });
      if (["awaiting_review", "blocked", "failed"].includes(getTask(db, a.id).state)) break;
    }
    const ta = getTask(db, a.id);
    assert.equal(ta.state, "awaiting_review", "越界写不该让整单失败：" + ta.last_error);

    const evs = db.prepare("SELECT type, payload FROM events WHERE task_id = ? ORDER BY id").all(a.id);
    const restored = evs.filter((e) => e.type === "workspace.restored").map((e) => JSON.parse(e.payload));
    assert.equal(restored.length, 1, "越界写必须留下一条 workspace.restored 事件");
    assert.ok(restored[0].files.some((p) => p.includes("escaped.test.mjs")), "要指名道姓说清了哪个文件");
    assert.ok(restored[0].files.some((p) => p.includes("src/calc.mjs")));
    assert.equal(escapes, 1);

    // 主仓库回到干净状态（除了人自己那份草稿）
    const dirty = statusPorcelain(repo).map((e) => e.path);
    assert.deepEqual(dirty, ["notes.txt"], "coder 越界写的东西要被收回，人的草稿要留着");
    assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "人写的草稿，别动\n");
    assert.ok(!existsSync(join(repo, "test/escaped.test.mjs")), "越界新建的文件要删掉");
    assert.ok(!readFileSync(join(repo, "src/calc.mjs"), "utf8").includes("42"), "越界改的跟踪文件要还原");

    // 第二单：主仓库有别人的未提交改动时，合并必须 blocked 并说清是哪几个文件
    const b = createTask(db, { title: "再实现一次 add", repo: "repo", owner: "alice", budgetTokens: 1000000 });
    for (let i = 0; i < 8; i++) {
      await pump(db, { workerId: "w-contain", provider, once: true });
      if (["awaiting_review", "blocked", "failed"].includes(getTask(db, b.id).state)) break;
    }
    assert.equal(getTask(db, b.id).state, "awaiting_review");
    writeFileSync(join(repo, "human-wip.txt"), "人正在改的东西\n");
    transition(db, b.id, "awaiting_approval", { actor: "bob", reason: "first review passed" });
    record(db, { taskId: b.id, type: "human.decision", actor: "lead", payload: { decision: "approved", by: "lead", note: "合" } });
    transition(db, b.id, "merging", { actor: "lead", reason: "approved" });
    await pump(db, { workerId: "w-contain", provider, once: true });
    const tb = getTask(db, b.id);
    assert.equal(tb.state, "blocked", "主仓库脏时不能假装合并成功");
    const why = String(tb.evidence && tb.evidence.last_error);
    assert.match(why, /未提交改动/, "理由要人话：" + why);
    assert.match(why, /human-wip\.txt/, "要指出是哪个文件");
  } finally {
    delete process.env.WB_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});
