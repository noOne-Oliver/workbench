#!/usr/bin/env node
// 把 sandbox/demo 恢复到种子状态，用于反复演示/验收。不碰业务数据（data/）。
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "sandbox/demo");
const sh = (cmd, args, cwd = REPO) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();

if (!existsSync(resolve(REPO, ".git"))) {
  console.error("sandbox/demo 不是 git 仓库，先跑 npm run init");
  process.exit(1);
}

// 先清 worktree 和分支，否则 reset --hard 会留下悬挂状态
const wtDir = resolve(ROOT, "worktrees");
if (existsSync(wtDir)) rmSync(wtDir, { recursive: true, force: true });
sh("git", ["worktree", "prune"]);

const branches = sh("git", ["branch", "--list", "wb/*"]).split("\n").map((s) => s.replace(/^\*?\s*/, "").trim()).filter(Boolean);
for (const b of branches) { try { sh("git", ["branch", "-d", b]); } catch { /* 未合并的分支留着，不强制删 */ } }

// 以 seed 标签为种子（比 root commit 更可控：种子仓库自身也会演进）
let seed;
try { seed = sh("git", ["rev-parse", "seed"]); }
catch { seed = sh("git", ["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0]; }
sh("git", ["reset", "--hard", seed]);
sh("git", ["clean", "-fd"]);

console.log("demo 已重置到种子提交 " + seed.slice(0, 7));