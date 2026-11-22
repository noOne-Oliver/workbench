import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runGuards, parseTestCases, compareBaseline } from "../src/runner/guards.mjs";

// 测试用的仓库里没有 npm 依赖，统一走 node --test，避免机器差异
process.env.WB_NO_NPM = "1";

test("TAP 解析：用例名与失败原因都认得（node --test 与 mocha 两种风格）", () => {
  const out = [
    "# Subtest: 加法",
    "ok 1 - 加法",
    "# Subtest: 减法",
    "not ok 2 - 减法",
    "  ---",
    "  duration_ms: 1.2",
    "  error: 'expected 1 to equal 2'",
    "  code: 'ERR_ASSERTION'",
    "1..2",
  ].join("\n");
  const p = parseTestCases(out);
  assert.equal(p.total, 2);
  assert.equal(p.pass, 1);
  assert.equal(p.fail, 1);
  assert.equal(p.cases[1].name, "减法");
  assert.match(p.cases[1].detail.join(" "), /expected 1 to equal 2/, "失败原因要能读到");

  const mocha = parseTestCases("  ✓ 加法\n  ✗ 减法\n  1 passing\n");
  assert.equal(mocha.total, 2, "mocha 风格也要认");
  assert.equal(mocha.fail, 1);
});

test("基线对比：回退 / 修好 / 新增 / 删除 四类分得清", () => {
  const base = [
    { name: "a", ok: true },
    { name: "b", ok: true },
    { name: "c", ok: false },
  ];
  const now = [
    { name: "a", ok: true },
    { name: "b", ok: false },
    { name: "c", ok: true },
    { name: "d", ok: true },
  ];
  const cmp = compareBaseline(base, now);
  assert.deepEqual(cmp.regressions, ["b"], "原来过的 b 现在挂了");
  assert.deepEqual(cmp.fixed, ["c"], "原来挂的 c 现在过了");
  assert.deepEqual(cmp.added, ["d"]);
  assert.deepEqual(cmp.removed, []);
  assert.equal(cmp.basePassCount, 2);
});

/** 造一个 base 里两条用例全绿、work 里把其中一条改挂并新增一条的仓库。 */
function repoWithRegression() {
  const repo = mkdtempSync(join(tmpdir(), "wb-reg-"));
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "calc.mjs"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  writeFileSync(join(repo, "test", "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add, sub } from "../calc.mjs";',
    'test("加法", () => { assert.equal(add(1, 2), 3); });',
    'test("减法", () => { assert.equal(sub(3, 1), 2); });',
  ].join("\n"));
  sh("git", ["init", "-q"]);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const base = sh("git", ["rev-parse", "HEAD"]).trim();
  // 改成"减法写错"（回归）+ 新增一条用例
  writeFileSync(join(repo, "calc.mjs"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  writeFileSync(join(repo, "test", "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add, sub } from "../calc.mjs";',
    'test("加法", () => { assert.equal(add(1, 2), 3); });',
    'test("减法", () => { assert.equal(sub(3, 1), 2); });',
    'test("乘法", () => { assert.equal(add(2, 2), 4); });',
  ].join("\n"));
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
  return { repo, base };
}

test("回归：base 里能过的用例被改挂 → no_regression 失败，并且指名道姓是哪条", () => {
  const { repo, base } = repoWithRegression();
  const g = runGuards({ workdir: repo, base });
  const c = g.checks.find((x) => x.id === "no_regression");
  assert.ok(c, "要有 no_regression 这条护栏");
  assert.equal(c.ok, false, "既有用例从绿变红必须拦住");
  assert.match(c.detail, /减法/, "要说清是哪条用例挂了");
  assert.equal(g.baseline.regressions.includes("减法"), true);
  assert.equal(g.baseline.added.includes("乘法"), true, "新增用例也要记下来");
  assert.equal(g.testCases.total, 3, "用例清单给界面用");
  assert.equal(g.testCases.fail, 1);
});

test("回归：基线本身就不绿时，不把老账算在这次改动上", () => {
  const repo = mkdtempSync(join(tmpdir(), "wb-reg2-"));
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "test", "a.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("一直挂", () => { assert.equal(1, 2); });',
  ].join("\n"));
  sh("git", ["init", "-q"]);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const base = sh("git", ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "README.md"), "x\n");
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
  const g = runGuards({ workdir: repo, base });
  const c = g.checks.find((x) => x.id === "no_regression");
  assert.equal(c.ok, true, "老本来就挂的用例，不算这次回退");
  assert.equal(g.baseline.ok, false, "但基线不绿这件事要如实报出来");
  assert.match(c.detail, /基线本身有 1 条本就失败/);
});

test("用例改名不算回退，但要如实说『删掉了几条原本能过的』", () => {
  const cmp = compareBaseline(
    [{ name: "加法", ok: true }, { name: "减法", ok: true }],
    [{ name: "add", ok: true }, { name: "sub", ok: true }, { name: "mul", ok: true }],
  );
  assert.deepEqual(cmp.regressions, [], "改名不是回退，否则每轮都误报");
  assert.deepEqual(cmp.removed, ["加法", "减法"]);
  assert.deepEqual(cmp.added, ["add", "sub", "mul"]);
});

test("回归：改名 + 全绿 → no_regression 通过，但 detail 提醒删了几条", () => {
  const repo = mkdtempSync(join(tmpdir(), "wb-reg3-"));
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "test", "a.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("加法", () => { assert.equal(1 + 2, 3); });',
  ].join("\n"));
  sh("git", ["init", "-q"]);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const base = sh("git", ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "test", "a.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("add", () => { assert.equal(1 + 2, 3); });',
  ].join("\n"));
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
  const g = runGuards({ workdir: repo, base });
  const c = g.checks.find((x) => x.id === "no_regression");
  assert.equal(c.ok, true, "改名后全绿，不该拦");
  assert.match(c.detail, /删掉了 1 条原本能过的/);
});
