import { spawn } from "node:child_process";

/**
 * opencode provider：每个角色一次全新会话（不 --continue），
 * 保证 Verifier 不是 Coder 的同一实例——这是"人只 review"能否成立的前提。
 */
export default async function createOpencode(opts) {
  const model = (opts && opts.model) || process.env.WB_MODEL || null;
  return {
    name: "opencode",
    async run({ prompt, cwd, timeoutMs }) {
      const args = ["run", prompt, "--dir", cwd, "--format", "json"];
      if (model) args.push("--model", model);
      return await execOpencode(args, cwd, timeoutMs || 900000);
    },
  };
}

function execOpencode(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn("opencode", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      finish({ ok: false, error: "timeout " + timeoutMs + "ms", text: out, tokens: estimate(out) });
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => finish({ ok: false, error: String(e.message), text: out, tokens: estimate(out) }));
    p.on("close", (code) => {
      const parsed = parseEvents(out);
      const text = parsed.text || out;
      const tokens = parsed.tokens || estimate(text);
      if (code !== 0) return finish({ ok: false, error: "exit " + code + ": " + String(out).slice(-600), text, tokens });
      finish({ ok: true, text, tokens });
    });
  });
}

/** opencode --format json 是逐行 JSON 事件，尽力抽取文本与 usage。 */
function parseEvents(raw) {
  let text = "";
  let tokens = 0;
  for (const line of String(raw).split("\n")) {
    const s = line.trim();
    if (s.charAt(0) !== "{") continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    const t = (ev && ev.part && ev.part.text) || (ev && ev.text) || (ev && ev.content);
    if (typeof t === "string") text += t;
    const u = (ev && ev.usage) || (ev && ev.part && ev.part.tokens);
    if (u) tokens += (u.input_tokens || u.input || 0) + (u.output_tokens || u.output || 0);
  }
  return { text, tokens };
}

function estimate(s) { return Math.max(1, Math.ceil(String(s).length / 4)); }
