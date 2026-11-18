import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "./worktree.mjs";

/**
 * 确定性护栏 —— 不依赖任何模型判断的那一层。
 * 这是"伪绿照妖镜"：agent 最常见的作弊是改测试或空断言，这里靠 git 与真实命令抓它。
 */

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const ASSERT_RE = /\b(assert|expect|should|XCTAssert|#expect)\b/;

const DEFAULTS = { testCmd: ["npm", "test"], sizeLimitLines: 600, testTimeoutMs: 300000 };

export function loadRepoConfig(workdir) {
  const p = join(workdir, "wb.config.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}

export function changedFiles(dir, base) {
  const r = sh("git", ["-C", dir, "diff", "--name-status", base + "..HEAD"]);
  if (!r.ok) return [];
  return r.out.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0].charAt(0), path: parts[parts.length - 1] };
  });
}

function testOutputTail(dir, base) {
  const r = sh("git", ["-C", dir, "diff", base + "..HEAD", "--", "*/test/*", "test/*"]);
  return r.ok ? r.out.slice(0, 4000) : "";
}

export function runGuards({ workdir, base, config, extra }) {
  const cfg = config || loadRepoConfig(workdir);
  const checks = [];
  const files = changedFiles(workdir, base);

  // 1. 测试必须真的跑，且真的绿
  const cmd = cfg.testCmd || DEFAULTS.testCmd;
  const run = sh(cmd[0], cmd.slice(1), { cwd: workdir, timeout: cfg.testTimeoutMs || DEFAULTS.testTimeoutMs });
  checks.push({
    id: "tests_pass",
    ok: run.ok,
    detail: run.ok ? "测试命令退出码 0" : "测试命令失败（exit " + run.code + "）",
  });

  // 2. 不许动既有测试文件（改或删都算削弱）
  const touchedTests = files.filter((f) => TEST_FILE_RE.test(f.path) && (f.status === "M" || f.status === "D"));
  checks.push({
    id: "no_test_weakening",
    ok: touchedTests.length === 0,
    detail: touchedTests.length === 0
      ? "未改动既有测试文件"
      : "改动了既有测试文件: " + touchedTests.map((f) => f.status + " " + f.path).join(", "),
  });

  // 3. 新增测试必须有断言
  const addedTests = files.filter((f) => TEST_FILE_RE.test(f.path) && f.status === "A");
  const emptyTests = addedTests.filter((f) => {
    try {
      const body = readFileSync(join(workdir, f.path), "utf8");
      return !ASSERT_RE.test(body);
    } catch { return true; }
  });
  checks.push({
    id: "no_empty_tests",
    ok: emptyTests.length === 0,
    detail: emptyTests.length === 0
      ? (addedTests.length ? "新增测试含断言" : "无新增测试文件")
      : "新增测试无任何断言: " + emptyTests.map((f) => f.path).join(", "),
  });

  // 4. 变更规模上限（防止越界重构）
  const numstat = sh("git", ["-C", workdir, "diff", "--numstat", base + "..HEAD"]);
  let lines = 0;
  if (numstat.ok) {
    for (const ln of numstat.out.split("\n").filter(Boolean)) {
      const c = ln.split("\t");
      lines += (parseInt(c[0], 10) || 0) + (parseInt(c[1], 10) || 0);
    }
  }
  const limit = cfg.sizeLimitLines || DEFAULTS.sizeLimitLines;
  checks.push({
    id: "diff_size",
    ok: lines <= limit,
    detail: "改动 " + lines + " 行（上限 " + limit + "）",
  });

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    files,
    testOutput: String(run.out || "").slice(-12000),
    testCmd: cmd.join(" "),
    testDiff: testOutputTail(workdir, base),
  };
}
