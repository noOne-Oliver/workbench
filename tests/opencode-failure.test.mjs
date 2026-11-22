import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFailure, ensureOverlay } from "../src/runner/providers/opencode.mjs";

const ev = (o) => JSON.stringify(o);

// 真实事件形状（2026-11-22 从 /tmp/wb-real-ws 抓到）：被拒的工具只有 state.error，正文为空。
const rejected = [
  ev({ type: "step_start", part: { type: "step-start" } }),
  ev({ type: "tool_use", part: { type: "tool", tool: "read", state: { status: "error", input: { filePath: "/x/demo/package.json" }, error: "PermissionRejectedError({\"_tag\":\"PermissionRejectedError\"})" } } }),
  ev({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls", tokens: { total: 21888 } } }),
].join("\n");

test("工具被权限拒绝时不重试（否则同样一幕再烧五轮钱）", () => {
  const f = classifyFailure(rejected);
  assert.equal(f.fatal, true);
  assert.match(f.error, /拒绝了文件访问/);
  assert.match(f.error, /external_directory/);
});

test("普通空产出仍可重试，但要说清是停在哪一步", () => {
  const f = classifyFailure(ev({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } }));
  assert.equal(f.fatal, false);
  assert.match(f.error, /reason=tool-calls/);
});

test("有正文就不算失败", () => {
  const ok = [ev({ type: "text", part: { type: "text", text: "切片一：实现除法" } })].join("\n");
  assert.equal(classifyFailure(ok), null);
});

test("overlay 把工作区根目录划进 external_directory，且可重复调用", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-oc-"));
  const old = process.env.WB_ROOT;
  process.env.WB_ROOT = "/tmp/wb-ws-x";
  try {
    const file = ensureOverlay(home);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(cfg.permission.external_directory["/tmp/wb-ws-x/*"], "allow");
    const again = ensureOverlay(home);
    assert.equal(again, file);
    assert.equal(fs.readFileSync(again, "utf8"), fs.readFileSync(file, "utf8"));
  } finally {
    if (old === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
