import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { sh } from "../runner/worktree.mjs";

/**
 * 工作区（workspace）= 内核唯一需要写的地方。
 * 打包后的 app 第一次启动会在这里建目录和一个起始仓库，之后所有账本/工作树/凭据都留在这儿，
 * 卸载 app 不会带走数据，备份就拷贝这一个目录。
 */
const STARTER = {
  "package.json": JSON.stringify({ name: "workspace-demo", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": [
    "# 起始仓库",
    "",
    "工作台把它当演示目标：让 agent 把 calc 的减法/乘法/除法补齐，测试里已经写好了加法。",
    "",
    "跑测试: node --test",
    "",
  ].join("\n"),
  "src/calc.mjs": [
    "// 只实现了加法；减法/乘法/除法是留给 agent 的活。",
    "export function calc(a, b, op) {",
    "  if (op === \"+\") return a + b;",
    "  throw new Error(\"未实现: \" + op);",
    "}",
    "",
  ].join("\n"),
  "test/calc.test.mjs": [
    "import test from \"node:test\";",
    "import assert from \"node:assert/strict\";",
    "import { calc } from \"../src/calc.mjs\";",
    "",
    "test(\"加法\", () => {",
    "  assert.equal(calc(2, 3, \"+\"), 5);",
    "});",
    "",
  ].join("\n"),
};

function ensureStarter(repoDir) {
  if (existsSync(join(repoDir, ".git"))) return { path: repoDir, created: false };
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "test"), { recursive: true });
  for (const [p, body] of Object.entries(STARTER)) writeFileSync(join(repoDir, p), body);
  const git = (args) => sh("git", ["-C", repoDir, ...args]);
  if (!git(["init", "-q"]).ok) return { path: repoDir, created: false, error: "git init 失败" };
  git(["add", "-A"]);
  const c = sh("git", ["-C", repoDir, "-c", "user.email=workbench@local", "-c", "user.name=Workbench", "commit", "-qm", "seed: 工作台起始仓库"]);
  return { path: repoDir, created: true, ...(c.ok ? {} : { error: c.out }) };
}

/** 幂等：已有就补缺的目录，绝不覆盖账本或仓库。 */
export function ensureWorkspace(dir) {
  const root = resolve(dir);
  const made = [];
  for (const sub of ["data", "worktrees", ".oc"]) {
    const p = join(root, sub);
    if (!existsSync(p)) { mkdirSync(p, { recursive: true }); made.push(sub); }
  }
  const starter = ensureStarter(join(root, "demo"));
  return {
    root,
    db: join(root, "data/ledger.db"),
    starterRepo: starter.path,
    created: made,
    starterCreated: starter.created,
    ...(starter.error ? { starterError: starter.error } : {}),
  };
}
