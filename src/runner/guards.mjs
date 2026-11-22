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

const ASSERT_G = /\b(assert|expect|should|XCTAssert|#expect)\b/g;
const CASE_G = /\b(?:test|it|describe)\s*\(/g;

function countTests(src) {
  const s = String(src || "");
  return {
    tests: (s.match(CASE_G) || []).length,
    asserts: (s.match(ASSERT_G) || []).length,
  };
}

function gitShow(dir, ref, path) {
  const r = sh("git", ["-C", dir, "show", ref + ":" + path]);
  return r.ok ? r.out : "";
}

function testOutputTail(dir, base) {
  const r = sh("git", ["-C", dir, "diff", base + "..HEAD", "--", "*/test/*", "test/*"]);
  return r.ok ? r.out.slice(0, 4000) : "";
}


// ---- 同义反复检测（测试把实现里的同一个调用当成期望值） ----
// 例：实现 return Math.pow(a,b)；测试 assert.equal(pow(2,0.5), Math.pow(2,0.5))
// 测试永远是绿的——因为它校验的不是"实现对不对"，而是"实现等于实现"。

const SRC_FILE_RE = /\.(m|c)?[jt]sx?$/i;
const SKIP_CALLEES = new Set(["console.log", "console.error", "console.warn", "JSON.parse"]);

function sliceBalanced(src, openIdx) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const open = src[openIdx];
  const close = pairs[open];
  if (!close) return { body: "", end: openIdx };
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i };
    }
  }
  return { body: src.slice(openIdx + 1), end: src.length };
}

function paramNames(paramSrc) {
  return String(paramSrc || "")
    .split(",")
    .map((p) => p.trim().replace(/=.*$/, "").trim())
    .map((p) => (/^[A-Za-z_$][\w$]*$/.test(p) ? p : ""))
    .filter(Boolean);
}

/** 从源码里抠出函数名、形参、函数体；支持 function 声明与箭头函数。 */
export function extractFunctions(src) {
  const s = String(src || "");
  const out = [];
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = decl.exec(s))) {
    const openIdx = s.indexOf("(", m.index + m[0].length - 1);
    const { end } = sliceBalanced(s, openIdx);
    const braceIdx = s.indexOf("{", end);
    if (braceIdx < 0) continue;
    const body = sliceBalanced(s, braceIdx).body;
    const params = paramNames(s.slice(openIdx + 1, end));
    out.push({ name: m[1], params, body });
  }
  const arrow = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = arrow.exec(s))) {
    const openIdx = s.indexOf("(", m.index + m[0].length - 1);
    const { end } = sliceBalanced(s, openIdx);
    const params = paramNames(s.slice(openIdx + 1, end));
    const rest = s.slice(end + 1);
    const arrowAt = rest.indexOf("=>");
    if (arrowAt < 0 || arrowAt > 8) continue;
    const afterArrow = s.slice(end + 1 + arrowAt + 2);
    const trimmed = afterArrow.replace(/^\s*/, "");
    let body = "";
    if (trimmed.startsWith("{")) {
      const braceIdx = s.indexOf("{", end + 1 + arrowAt + 2);
      body = sliceBalanced(s, braceIdx).body;
    } else {
      const stop = trimmed.search(/;\s*(\n|$)/);
      body = stop >= 0 ? trimmed.slice(0, stop) : trimmed.split("\n")[0];
    }
    out.push({ name: m[1], params, body });
  }
  return out;
}

/**
 * 函数体里"实现所依赖的调用"：
 *  - 命名空间调用 Math.pow / JSON.stringify / xs.slice…
 *  - 同文件内定义的辅助函数 double(...)
 * 排除形参自身的成员调用（a.slice() 这种是操作入参，不算实现手段）。
 */
export function calleesOf(body, params, knownFns) {
  const own = new Set(params || []);
  const src = String(body || "");
  const found = new Set();
  const dotted = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  let m;
  while ((m = dotted.exec(src))) {
    const full = m[1].replace(/\s+/g, "");
    if (own.has(full.split(".")[0])) continue;
    if (SKIP_CALLEES.has(full)) continue;
    found.add(full);
  }
  if (knownFns && knownFns.size) {
    const plain = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = plain.exec(src))) {
      const name = m[1];
      if (own.has(name) || !knownFns.has(name)) continue;
      found.add(name);
    }
  }
  return found;
}

function splitTopLevelArgs(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

const ASSERT_CALLS = [
  /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual)\s*\(/g,
  /\.(?:toBe|toEqual|toStrictEqual)\s*\(/g,
];

/**
 * 断言的"实际值"和"期望值"是不是同一个表达式（忽略空白与引号风格）。
 * 例：calc(2,3) vs calc(2, 3)、pow(2,0.5) vs pow(2,"0.5" 不算，引号统一后才算)。
 * 这是与实现无关的恒真判据 —— 实现只用运算符时也必须检查。
 */
export function sameExpression(a, b) {
  const norm = (x) => String(x || "").replace(/\s+/g, "").replace(/["']/g, '"');
  const x = norm(a), y = norm(b);
  return Boolean(x) && x === y && x.includes("(");
}

/** 判断期望值是不是"实现里同一个调用"的复制品；返回命中的调用名或 null。 */
export function tautologyIn(actual, expected, fnName, callees) {
  const a = String(actual || "").replace(/\s+/g, " ").trim();
  const b = String(expected || "").replace(/\s+/g, " ").trim();
  if (!a || !b) return null;
  // 类别一：两边是同一个表达式（含同函数不同参数）
  if (sameExpression(a, b)) return a;
  // 类别二：期望值是纯调用，且这个调用正是实现内部的实现手段
  const pure = /^[A-Za-z_$][\w$.]*\s*\([\s\S]*\)$/.exec(b);
  if (!pure) return null;
  const head = pure[0].split("(")[0].replace(/\s+/g, "");
  const actualCalls = String(a).match(/[A-Za-z_$][\w$.]*\s*\(/g) || [];
  const usesImpl = actualCalls.some((c) => c.replace(/\s+/g, "").replace(/\($/, "") === fnName);
  if (!usesImpl) return null;
  if (callees.has(head)) return head;
  return null;
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

  // 2. 不许把测试改弱：删文件、或断言/用例数变少都算削弱。
  //    允许"加强测试"（数量不减），否则正常任务会被误杀。
  const touchedTests = files.filter((f) => TEST_FILE_RE.test(f.path) && (f.status === "M" || f.status === "D"));
  const weakened = [];
  for (const f of touchedTests) {
    if (f.status === "D") { weakened.push(f.path + " (已删除)"); continue; }
    const before = gitShow(workdir, base, f.path);
    let after = "";
    try { after = readFileSync(join(workdir, f.path), "utf8"); } catch { after = ""; }
    const b = countTests(before);
    const a = countTests(after);
    if (a.tests < b.tests || a.asserts < b.asserts) {
      weakened.push(f.path + " (用例 " + b.tests + "->" + a.tests + "，断言 " + b.asserts + "->" + a.asserts + ")");
    }
  }
  checks.push({
    id: "no_test_weakening",
    ok: weakened.length === 0,
    detail: weakened.length === 0
      ? (touchedTests.length ? "改动了测试但未削弱（用例/断言数不减）" : "未改动既有测试文件")
      : "测试被削弱: " + weakened.join("；"),
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

  // 5. 不许"同义反复"测试：期望值直接抄实现里的同一个调用。
  //    例：实现 return Math.pow(a,b) → 测试 assert.equal(pow(2,0.5), Math.pow(2,0.5))
  //    这种测试永远绿，因为它校验的是"实现等于实现"，也就测不出实现写错。
  const implFiles = files.filter((f) =>
    (f.status === "A" || f.status === "M") && !TEST_FILE_RE.test(f.path) && SRC_FILE_RE.test(f.path));
  const implFns = new Map();
  for (const f of implFiles) {
    let src = "";
    try { src = readFileSync(join(workdir, f.path), "utf8"); } catch { continue; }
    const fns = extractFunctions(src);
    const known = new Set(fns.map((fn) => fn.name));
    for (const fn of fns) {
      const callees = calleesOf(fn.body, fn.params, known);
      if (callees.size) implFns.set(fn.name, { file: f.path, callees });
    }
  }
  const tautologies = [];
  const testFiles = files.filter((f) =>
    TEST_FILE_RE.test(f.path) && (f.status === "A" || f.status === "M"));
  for (const f of testFiles) {
    let src = "";
    try { src = readFileSync(join(workdir, f.path), "utf8"); } catch { continue; }
    src.split("\n").forEach((line, idx) => {
      if (line.length > 600) return;
      for (const re of ASSERT_CALLS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const openIdx = line.indexOf("(", m.index + m[0].length - 1);
          const args = splitTopLevelArgs(sliceBalanced(line, openIdx).body);
          if (args.length < 2) continue;
          // 类别一：断言的期望值与实际值是同一表达式 —— 恒真，与实现长什么样无关。
          // 必须放在 implFns 门之外：实现只用运算符（a+b / a**b）时 implFns 为空，
          // 否则 assert.equal(calc(2,3), calc(2,3)) 会直接漏过去。
          if (sameExpression(args[0], args[1])) {
            tautologies.push(f.path + ":" + (idx + 1) + " 断言的期望值与实际值完全一样: " + args[0].trim());
            continue;
          }
          // 类别二：期望值是实现内部同一个调用的复制品（需要实现信息）。
          for (const [fnName, meta] of implFns) {
            if (!new RegExp("\\b" + fnName + "\\s*\\(").test(line)) continue;
            const hit = tautologyIn(args[0], args[1], fnName, meta.callees)
              || tautologyIn(args[1], args[0], fnName, meta.callees);
            if (!hit) continue;
            tautologies.push(f.path + ":" + (idx + 1) + " 「" + fnName + "」的期望值就是实现里的 " + hit);
          }
        }
      }
    });
  }
  checks.push({
    id: "no_tautological_test",
    ok: tautologies.length === 0,
    detail: tautologies.length === 0
      ? (implFns.size
        ? "断言未复制实现内部的调用，两边也不是同一表达式"
        : "实现只含字面量/入参：已按「两边同一表达式」检查，未发现恒真断言")
      : "同义反复测试（测不出实现错）: " + tautologies.join("；"),
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
