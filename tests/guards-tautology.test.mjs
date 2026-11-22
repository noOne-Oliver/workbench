import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runGuards, extractFunctions, calleesOf, tautologyIn, testCommandFor } from "../src/runner/guards.mjs";

const chk = (g, id) => g.checks.find((c) => c.id === id);

/** 造一个"实现了 pow、测试把 Math.pow 抄成期望值"的仓库。 */
function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "wb-taut-"));
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  sh("git", ["init", "-q"]);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base", "--allow-empty"]);
  const base = sh("git", ["rev-parse", "HEAD"]).trim();
  for (const [p, body] of Object.entries(files)) writeFileSync(join(repo, p), body);
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
  return { repo, base };
}

const IMPL = [
  "export function pow(a, b) {",
  "  return Math.pow(a, b);",
  "}",
  "",
].join("\n");

test("同义反复：期望值抄实现里的同一个调用，被判 fail", () => {
  const { repo, base } = repoWith({
    "src/calc.mjs": IMPL,
    "test/calc.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { pow } from "../src/calc.mjs";',
      'test("pow", () => { assert.equal(pow(2, 0.5), Math.pow(2, 0.5)); });',
      'test("pow2", () => { assert.equal(pow(2, 10), 1024); });',
    ].join("\n"),
  });
  const g = runGuards({ workdir: repo, base });
  const c = chk(g, "no_tautological_test");
  assert.equal(c.ok, false, "期望值就是 Math.pow，测不出实现写错");
  assert.match(c.detail, /calc\.test\.mjs:4/, "要指出具体哪一行");
  assert.equal(g.ok, false, "整轮护栏因此失败");
});

test("同义反复：两边是同一个表达式（含同函数不同参数）也算", () => {
  const { repo, base } = repoWith({
    "src/calc.mjs": IMPL,
    "test/calc.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { pow } from "../src/calc.mjs";',
      'test("x", () => { assert.equal(pow(2, 3), pow(2, 3)); });',
    ].join("\n"),
  });
  const g = runGuards({ workdir: repo, base });
  assert.equal(chk(g, "no_tautological_test").ok, false);
});

test("正常测试：期望值是字面量、或用 ** 运算（实现没用 Math.pow）→ 放行", () => {
  const { repo, base } = repoWith({
    "src/calc.mjs": "export function pow(a, b) {\n  return a ** b;\n}\n",
    "test/calc.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { pow } from "../src/calc.mjs";',
      'test("平方", () => { assert.equal(pow(2, 10), 1024); });',
      'test("半次方", () => { assert.ok(Math.abs(pow(2, 0.5) - Math.SQRT2) < 1e-12); });',
    ].join("\n"),
  });
  const g = runGuards({ workdir: repo, base });
  assert.equal(chk(g, "no_tautological_test").ok, true, "期望值是常量/性质断言，不是抄实现");
  assert.equal(g.ok, true);
});

test("同文件辅助函数也算实现手段", () => {
  const src = [
    "function square(x) { return x * x; }",
    "export function area(r) { return square(r) * 3; }",
  ].join("\n");
  const fns = extractFunctions(src);
  const known = new Set(fns.map((f) => f.name));
  const fn = fns.find((f) => f.name === "area");
  const callees = calleesOf(fn.body, fn.params, known);
  assert.ok(callees.has("square"), "应把同文件辅助函数识别为实现手段");
  assert.equal(tautologyIn("area(2)", "square(2) * 3", "area", callees), null, "期望值是复合表达式（不是纯调用）时放行");
  assert.equal(tautologyIn("area(2)", "square(2)", "area", new Set(["square"])), "square");
});

import { coderPrompt } from "../src/runner/sop.mjs";
import { retryFeedback } from "../src/runner/worker.mjs";

test("重试的 Coder 会拿到上一轮失败原因（不是无脑重试）", () => {
  const task = {
    evidence: {
      verify: {
        guards: [
          { id: "no_tautological_test", ok: false, detail: "test/calc.test.mjs:12 「pow」的期望值就是实现里的 Math.pow" },
          { id: "diff_size", ok: true, detail: "改动 13 行" },
        ],
        verdict: { verdict: "fail", summary: "测试与实现同义反复", raised: ["0/0 语义待确认"] },
      },
    },
  };
  const fb = retryFeedback(task);
  assert.match(fb, /no_tautological_test/, "要带上护栏 id");
  assert.match(fb, /Math\.pow/, "要带上具体证据");
  assert.match(fb, /0\/0 语义待确认/, "要带上 Verifier 上抛点");
  assert.equal(retryFeedback({}), "", "没有失败证据时不加噪音");
  const prompt = coderPrompt({ title: "x" }, "plan", 1, fb);
  assert.match(prompt, /上一轮为什么没过/);
  assert.match(prompt, /Math\.pow/);
});


import { reserveShort } from "../src/runner/worker.mjs";
import { resetToBase } from "../src/runner/worktree.mjs";
import { readFileSync, existsSync } from "node:fs";

test("重试从基线重来：不重置会让 coder 看见上一轮的代码", () => {
  const repo = mkdtempSync(join(tmpdir(), "wb-reset-"));
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: "utf8" });
  sh("git", ["init", "-q"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/a.mjs"), "export const a = 1;\n");
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  const base = sh("git", ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "src/a.mjs"), "export const a = 2;\n");
  writeFileSync(join(repo, "src/junk.mjs"), "// 上一轮留下的垃圾\n");
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "attempt1"]);
  assert.equal(readFileSync(join(repo, "src/a.mjs"), "utf8"), "export const a = 2;\n");

  const r = resetToBase(repo, base);
  assert.equal(r.ok, true);
  assert.equal(sh("git", ["rev-parse", "HEAD"]).trim(), base, "HEAD 回到基线");
  assert.match(readFileSync(join(repo, "src/a.mjs"), "utf8"), /a = 1/, "工作区内容回到基线");
  assert.equal(existsSync(join(repo, "src/junk.mjs")), false, "上一轮的未跟踪文件要清掉");
});

test("预算不足时提前拦住，不留半截活", () => {
  assert.match(reserveShort({ budget_tokens: 1000000, spent_tokens: 900000 }), /预算不足/);
  assert.equal(reserveShort({ budget_tokens: 1000000, spent_tokens: 300000 }), "");
  assert.equal(reserveShort({ budget_tokens: 0, spent_tokens: 0 }), "", "没设预算就不拦");
  assert.equal(reserveShort({ budget_tokens: 1000000, spent_tokens: 800000 }, 0.05), "", "比例调低就放行");
});


test("实现只含运算符时，恒真断言也必须被抓（曾经的假绿漏洞）", () => {
  const { repo, base } = repoWith({
    "src/calc.mjs": [
      "export function calc(a, b, op) {",
      '  if (op === "+") return a + b;',
      '  if (op === "-") return a - b;',
      "  return a * b;",
      "}",
      "",
    ].join("\n"),
    "test/calc.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { calc } from "../src/calc.mjs";',
      'test("加", () => { assert.equal(calc(2, 3, "+"), calc(2, 3, "+")); });',
      'test("减", () => { assert.equal(calc(5, 3, "-"), 2); });',
    ].join("\n"),
  });
  const g = runGuards({ workdir: repo, base });
  const c = chk(g, "no_tautological_test");
  assert.equal(c.ok, false, "实现只用运算符时，两边同一表达式仍是恒真断言");
  assert.match(c.detail, /calc\.test\.mjs:4/, "要指出具体哪一行");
  assert.match(c.detail, /期望值与实际值/, "要说清是哪类同义反复");
});

test("没有 npm 的机器（打包后的 app）退回 node --test，不能把「跑不起来」当「测试不过」", () => {
  assert.deepEqual(testCommandFor({ testCmd: ["npm", "test"] }, { npmOk: false }).cmd, [process.execPath, "--test"]);
  assert.match(testCommandFor({ testCmd: ["npm", "test"] }, { npmOk: false }).note, /node --test/);
  assert.deepEqual(testCommandFor({ testCmd: ["npm", "test"] }, { npmOk: true }).cmd, ["npm", "test"]);
  assert.deepEqual(testCommandFor({ testCmd: ["node", "--test"] }, { npmOk: false }).cmd, ["node", "--test"], "自定义命令不许被改");

  const { repo, base } = repoWith({
    "src/calc.mjs": "export function calc(a, b) {\n  return a + b;\n}\n",
    "test/calc.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { calc } from "../src/calc.mjs";',
      'test("add", () => { assert.equal(calc(2, 3), 5); });',
    ].join("\n"),
  });
  process.env.WB_NO_NPM = "1";
  try {
    const g = runGuards({ workdir: repo, base });
    const c = chk(g, "tests_pass");
    assert.equal(c.ok, true, "没有 npm 也要真跑起来测试");
    assert.match(c.detail, /退回 node --test/);
  } finally {
    delete process.env.WB_NO_NPM;
  }
});

