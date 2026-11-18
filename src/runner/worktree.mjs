import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function sh(cmd, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(cmd, args, {
      cwd: o.cwd, encoding: "utf8", timeout: o.timeout || 180000,
      stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, out: out || "", code: 0 };
  } catch (e) {
    const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    return { ok: false, out, code: e && e.status != null ? e.status : -1 };
  }
}

export function isGitRepo(dir) {
  return sh("git", ["-C", dir, "rev-parse", "--git-dir"]).ok;
}

export function headSha(dir) {
  const r = sh("git", ["-C", dir, "rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** 幂等：已存在就直接复用（崩溃恢复靠这条）。 */
export function ensureWorktree({ repo, dir, branch, base }) {
  if (existsSync(join(dir, ".git"))) return { ok: true, created: false, dir };
  const r = sh("git", ["-C", repo, "worktree", "add", "-B", branch, dir, base]);
  if (!r.ok) return { ok: false, error: r.out, dir };
  return { ok: true, created: true, dir };
}

/**
 * 重试前把 worktree 拉回基线。
 * 不这么做的话，第二次尝试看到的还是上一次已经写好的代码 —— coder 会"发现活已经干完了"，
 * 产出与上一轮逐字节相同的 diff，护栏照样不过，白烧一整轮 token（真实基准里就是这么翻车的）。
 */
export function resetToBase(dir, base) {
  const r = sh("git", ["-C", dir, "reset", "--hard", base]);
  if (!r.ok) return { ok: false, error: r.out };
  const c = sh("git", ["-C", dir, "clean", "-fdq"]);
  return { ok: c.ok, error: c.ok ? "" : c.out };
}

export function removeWorktree({ repo, dir }) {
  sh("git", ["-C", repo, "worktree", "remove", "--force", dir]);
  if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

export function commitAll(dir, message) {
  sh("git", ["-C", dir, "add", "-A"]);
  const r = sh("git", ["-C", dir, "commit", "-m", message, "--no-verify"]);
  if (r.ok) return { ok: true, sha: headSha(dir) };
  if (/nothing to commit|no changes added/i.test(r.out)) return { ok: true, sha: headSha(dir), empty: true };
  return { ok: false, error: r.out };
}

export function diffStat(dir, base) {
  const r = sh("git", ["-C", dir, "diff", "--shortstat", base + "..HEAD"]);
  return r.ok ? r.out.trim() : "";
}

export function diffPatch(dir, base, maxChars) {
  const r = sh("git", ["-C", dir, "diff", base + "..HEAD"]);
  return r.ok ? r.out.slice(0, maxChars || 40000) : "";
}
