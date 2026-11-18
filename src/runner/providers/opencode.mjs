import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * opencode provider：每个角色一次全新会话（不 --continue），
 * 保证 Verifier 不是 Coder 的同一实例——这是"人只 review"能否成立的前提。
 *
 * 2026-11-18 实测到的三个真实坑，这里全部兜住：
 * 1) opencode 必须写 ~/.local/share/opencode，沙箱里是只读的 → 把 XDG 三件套指进工作区。
 * 2) 模型额度耗尽时它不会退出，会一直挂着（实测 13 分钟 0 字节）→ 逐行看流，命中错误立刻 SIGKILL。
 * 3) 没有任何输出却 exit 0 的情况存在 → 空产出也算失败，不能当"干完了"。
 */

/** 这些字样出现在流里就说明这次调用已经废了，等下去只是烧时间。 */
const FATAL_PATTERNS = [
  /Free usage limit reached[^"\\]*/i,
  /AI_RetryError[^"\\]*/,
  /rate limit[^"\\]*/i,
  /No output generated[^"\\]*/i,
  /ProviderModelNotFoundError[^"\\]*/,
  /attempt to write a readonly database/i,
  /missing api key[^"\\]*/i,
  /unauthorized[^"\\]*/i,
  /insufficient[_ ]quota[^"\\]*/i,
];

export default async function createOpencode(opts = {}) {
  const model = opts.model || process.env.WB_MODEL || null;
  const home = path.resolve(opts.home || process.env.WB_OC_HOME || path.join(process.cwd(), ".oc"));
  return {
    name: "opencode",
    async run({ prompt, cwd, timeoutMs, idleMs }) {
      const args = ["run", prompt, "--dir", cwd, "--format", "json"];
      if (model) args.push("--model", model);
      return await execOpencode(args, cwd, {
        timeoutMs: timeoutMs || 900000,
        idleMs: idleMs || 180000,
        home,
        model,
      });
    },
  };
}

function execOpencode(args, cwd, { timeoutMs, idleMs, home, model }) {
  return new Promise((resolve) => {
    const env = {
      ...readProviderEnv(home),     // 本地凭据（.oc/private/provider.env，不进仓库）
      ...process.env,
      XDG_CONFIG_HOME: path.join(home, "config"),   // 自定义 provider 的 opencode.json 放这儿
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
    };
    const p = spawn("opencode", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let pending = "";        // 还没凑成整行的尾巴
    let done = false;
    let idle = null;

    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(wall);
      clearTimeout(idle);
      clearInterval(logTimer);
      try { p.kill("SIGKILL"); } catch {}
      resolve({ ...v, model: model || null, elapsedMs: Date.now() - started });
    };
    const started = Date.now();

    const wall = setTimeout(() => {
      finish({ ok: false, error: "wall timeout " + timeoutMs + "ms", text: parseEvents(out).text, tokens: parseEvents(out).tokens });
    }, timeoutMs);

    const bumpIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        finish({ ok: false, error: "idle timeout " + idleMs + "ms（引擎在跑但没有任何新输出）", text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      }, idleMs);
    };
    bumpIdle();

    const onChunk = (d) => {
      const s = d.toString();
      out += s;
      pending += s;
      bumpIdle();
      // 只看完整行，避免半行 JSON 误判
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        const fatal = fatalFromLine(line);
        if (fatal) return finish({ ok: false, error: fatal, text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      }
    };

    // opencode 把致命错误写进自己的日志文件，stdout 一个字节都不给（实测：限流时全程静默）。
    // 所以除了看流，还必须盯它自己的日志，否则只能等 wall timeout 才发现早已废掉。
    let logTimer = null;
    const logDir = path.join(env.XDG_DATA_HOME, "opencode", "log");
    let logCursor = null;
    const pollLog = () => {
      if (done) return;
      try {
        const names = fs.readdirSync(logDir).filter((f) => f.endsWith(".log")).sort();
        if (!names.length) return;
        const newest = names[names.length - 1];
        const file = path.join(logDir, newest);
        if (logCursor === null) {
          // 只认本次启动之后还在写的那个文件，避免捡到上一轮的历史错误
          if (fs.statSync(file).mtimeMs < started - 5000) return;
          logCursor = { file, offset: 0 };
        } else if (logCursor.file !== file) {
          logCursor = { file, offset: 0 };
        }
        const size = fs.statSync(file).size;
        if (size <= logCursor.offset) return;
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(size - logCursor.offset);
        fs.readSync(fd, buf, 0, buf.length, logCursor.offset);
        fs.closeSync(fd);
        logCursor.offset = size;
        const fatal = fatalFromLine(buf.toString());
        if (fatal) finish({ ok: false, error: fatal, text: parseEvents(out).text, tokens: parseEvents(out).tokens });
      } catch {
        // 日志目录可能还没建出来，下一轮再看
      }
    };
    logTimer = setInterval(pollLog, 1500);
    setTimeout(pollLog, 800);

    p.stdout.on("data", onChunk);
    p.stderr.on("data", onChunk);
    p.on("error", (e) => finish({ ok: false, error: "spawn failed: " + e.message, text: "", tokens: 0 }));

    p.on("close", (code) => {
      const parsed = parseEvents(out);
      const text = parsed.text || "";
      const tokens = parsed.tokens || estimate(text);
      if (code !== 0) {
        return finish({ ok: false, error: "exit " + code + ": " + String(out).slice(-600), text, tokens });
      }
      if (!text.trim()) {
        return finish({ ok: false, error: "空产出：exit 0 但没有任何文本（多半是被限流或模型空回）", text: "", tokens });
      }
      finish({ ok: true, text, tokens });
    });
  });
}

/** 从一行（可能就是错误事件的最后一行）里认出"已经废了"的原因。 */
function fatalFromLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  let ev = null;
  if (s.charAt(0) === "{") {
    try { ev = JSON.parse(s); } catch { ev = null; }
  }
  if (ev && ev.type === "error") {
    const e = ev.error || {};
    const msg = (e.data && (e.data.message || e.data.error)) || e.message || e.name || "unknown error";
    return "引擎报错: " + String(msg).slice(0, 400);
  }
  for (const re of FATAL_PATTERNS) {
    const m = s.match(re);
    if (m) return "引擎报错: " + String(m[0]).slice(0, 300);
  }
  return null;
}

/**
 * opencode --format json 是逐行 JSON 事件，形状随版本变，所以这里做宽进宽出：
 * 文本可能出现在 part.text / text / content；usage 可能在 usage / part.tokens。
 */
function parseEvents(raw) {
  let text = "";
  let tokens = 0;
  for (const line of String(raw).split("\n")) {
    const s = line.trim();
    if (s.charAt(0) !== "{") continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev.type === "error") continue;
    const part = ev.part || {};
    const cand = [part.text, ev.text, ev.content, part.content];
    for (const t of cand) if (typeof t === "string" && t) text += t;
    const u = ev.usage || part.tokens;
    if (u) {
      const total = u.total || ((u.input_tokens || u.input || 0) + (u.output_tokens || u.output || 0));
      tokens += total;
    }
  }
  return { text, tokens };
}

/** 本机凭据只从 .oc/private/provider.env 读，绝不进仓库；已存在的环境变量优先。 */
function readProviderEnv(home) {
  const file = path.join(home, "private/provider.env");
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // 没有本地凭据就是没有，交给引擎自己报错
  }
  return out;
}

function estimate(s) { return s ? Math.max(1, Math.ceil(String(s).length / 4)) : 0; }