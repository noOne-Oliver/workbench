#!/usr/bin/env node
/**
 * 引擎体检：60 秒内回答"这台机器现在能不能真跑"。
 * 用法：WB_ENGINE=opencode WB_MODEL=opencode/mimo-v2.6-flash-free node scripts/engine-smoke.mjs "只回复两个字母 OK"
 * 退出码：0 可用；2 不可用（原因打在 stdout，能直接贴给人看）。
 */
import { getProvider } from "../src/runner/engine.mjs";
import "../src/runner/providers/index.mjs";

const engine = process.env.WB_ENGINE || "opencode";
const prompt = process.argv[2] || "只回复两个字母 OK";
const cwd = process.env.WB_SMOKE_CWD || process.cwd();
const timeoutMs = Number(process.env.WB_SMOKE_TIMEOUT || 60000);

const provider = await getProvider(engine, { model: process.env.WB_MODEL, home: process.env.WB_OC_HOME });
const res = await provider.run({
  role: "smoke",
  prompt,
  cwd,
  task: { id: "smoke", title: prompt },
  attempt: 0,
  timeoutMs,
});

const line = (k, v) => console.log(k.padEnd(10), v);
line("engine", engine + (process.env.WB_MODEL ? " / " + process.env.WB_MODEL : ""));
line("ok", res.ok);
line("elapsed", ((res.elapsedMs || 0) / 1000).toFixed(1) + "s");
line("tokens", res.tokens || 0);
if (res.ok) {
  line("text", JSON.stringify(String(res.text).slice(0, 300)));
} else {
  line("error", String(res.error).slice(0, 800));
}
process.exit(res.ok ? 0 : 2);
