/**
 * 故障注入：把真实 provider 包一层，在指定时机往产物里注入"已知该被护栏抓住"的缺陷。
 *
 * 目的：让"护栏 FAIL → 打回 → 重置 → 重做 → 通过"这条链路能在真引擎上被观察到，
 * 而不是只靠单测假设它成立。注入是确定性的、只改测试文件、可被 evidence 里的 diff 看到。
 *
 *   WB_FAULT=tautology  # coder 第 0 次尝试后，把 assert.equal(f(...), 字面量) 改成 assert.equal(f(...), f(...))
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_FILE = /\.(test|spec)\.(mjs|cjs|js|ts)$/;
const SKIP_DIR = new Set([".git", "node_modules", "worktrees", ".oc", "dist", ".bench", "data"]);

/** 只认"调用 vs 数字字面量"这一种断言，是最容易被抄成同义反复的形态。 */
const ASSERT_NUM = /(assert\.(?:equal|strictEqual|deepEqual)\(\s*)([A-Za-z_$][\w$.]*\([^()]*\))(\s*,\s*)(-?\d+(?:\.\d+)?)(\s*\))/g;

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.name !== ".") {
      if (SKIP_DIR.has(ent.name)) continue;
    }
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walk(p, out);
    } else if (TEST_FILE.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 返回被改动的文件清单；没找到可注入的形态就返回空数组（不假装成功）。 */
export function injectTautology(cwd) {
  const changed = [];
  for (const file of walk(cwd)) {
    const src = readFileSync(file, "utf8");
    let n = 0;
    const out = src.replace(ASSERT_NUM, (_m, pre, call, sep, _lit, post) => {
      n += 1;
      return pre + call + sep + call + post;
    });
    if (n > 0) {
      writeFileSync(file, out);
      changed.push({ file: relative(cwd, file), count: n });
    }
  }
  return changed;
}

export function wrapProvider(base, fault) {
  if (!fault || fault === "none") return base;
  if (fault !== "tautology") throw new Error("未知 WB_FAULT: " + fault + "（可用: tautology）");

  return {
    ...base,
    name: base.name + "+fault:" + fault,
    async run(args) {
      const res = await base.run(args);
      const attempt = args.attempt ?? 0;
      if (fault === "tautology" && args.role === "coder" && attempt === 0 && res.ok) {
        const changed = injectTautology(args.cwd);
        if (changed.length) {
          process.stderr.write("[fault] attempt 0 注入同义反复测试: "
            + changed.map((c) => c.file + "×" + c.count).join(", ") + "\n");
          return { ...res, fault: { kind: "tautology", files: changed } };
        }
        process.stderr.write("[fault] 这批产物里没有 assert.equal(调用, 数字)，本次没注入\n");
      }
      return res;
    },
  };
}
