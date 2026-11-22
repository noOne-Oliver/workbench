import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { openDb } from "../core/db.mjs";
import { createTask, getTask, listTasks, transition, record, addEvidence } from "../core/ledger.mjs";
import { readForTask } from "../core/events.mjs";
import { feed as readFeed, live as readLive } from "../core/activity.mjs";
import { watchParent } from "../core/orphan.mjs";

// ROOT = 工作区（账本、worktrees、凭据都写这里）；CODE = 内核代码目录（打包后是 app 内的 Resources/kernel）。
// 两者分开，才能把内核塞进 .app 而数据留在用户自己的工作区。
const ROOT = resolve(process.env.WB_ROOT || process.cwd());
const CODE = resolve(process.env.WB_CODE || ROOT);
const WEB = resolve(CODE, "web");
const TOKEN = process.env.WB_TOKEN || "";
const PORT = Number(process.env.WB_PORT || 7317);
const HOST = process.env.WB_HOST || "127.0.0.1";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const COOKIE = "wb_token";

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 三种带法都认：cookie（浏览器登录后）、x-wb-token（脚本/外壳）、?token=（一次性链接）。 */
function authed(req) {
  if (!TOKEN) return true;
  const given = req.headers["x-wb-token"] || new URL(req.url, "http://x").searchParams.get("token") || cookies(req)[COOKIE] || "";
  return given === TOKEN;
}

function setCookie(res, value, maxAge) {
  res.setHeader("set-cookie", COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge);
}

async function readBody(req) {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  if (!buf) return {};
  try { return JSON.parse(buf); } catch { return {}; }
}

export function createApp(db) {
  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // 登录/登出自己不需要先登录（否则永远进不去）
    if (path === "/api/login" && req.method === "POST") {
      const b = await readBody(req);
      if (!TOKEN) return json(res, 200, { ok: true, tokenRequired: false });
      if (String(b.token || "") !== TOKEN) return json(res, 401, { error: "口令不对" });
      setCookie(res, TOKEN, 7 * 24 * 3600);
      return json(res, 200, { ok: true, tokenRequired: true });
    }
    if (path === "/api/logout" && req.method === "POST") {
      setCookie(res, "", 0);
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/api/") && !authed(req)) return json(res, 401, { error: "unauthorized" });

    try {
      if (req.method === "GET" && path === "/api/tasks") {
        const state = url.searchParams.get("state");
        return json(res, 200, { tasks: listTasks(db, { state: state || null }) });
      }
      // "后台在跑什么"：增量事件流 + 每个在跑的任务此刻的角色/时长/是否静默。
      // 界面不该只有状态徽章——状态是结果，事件才是过程。
      if (req.method === "GET" && path === "/api/activity") {
        const since = Number(url.searchParams.get("since") || 0);
        const limit = Number(url.searchParams.get("limit") || 120);
        const task = url.searchParams.get("task") || null;
        const events = readFeed(db, { since, limit, task });
        return json(res, 200, {
          events,
          live: readLive(db),
          cursor: events.length ? events[events.length - 1].id : since,
        });
      }
      if (req.method === "GET" && path === "/api/workspace") {
        const { credentialStatus } = await import("../core/credentials.mjs");
        const c = credentialStatus(ROOT);
        return json(res, 200, {
          root: ROOT, code: CODE,
          starterRepo: resolve(ROOT, "demo"),
          engine: process.env.WB_ENGINE || "mock",
          ocHome: c.ocHome,
          credentials: { providerEnv: c.providerEnv, providers: c.providers },
          auth: { tokenRequired: !!TOKEN },
        });
      }
      if (req.method === "POST" && path === "/api/tasks") {
        const b = await readBody(req);
        if (!b.title || !b.repo) return json(res, 400, { error: "title 与 repo 必填" });
        const t = createTask(db, {
          title: b.title, repo: b.repo, owner: b.owner || "unknown",
          budgetTokens: Number(b.budgetTokens || process.env.WB_BUDGET || 1_000_000),
        });
        return json(res, 201, { task: t });
      }
      const m = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const t = getTask(db, m[1]);
        if (!t) return json(res, 404, { error: "not found" });
        return json(res, 200, { task: t, events: readForTask(db, m[1]) });
      }
      const d = path.match(/^\/api\/tasks\/([^/]+)\/decision$/);
      if (req.method === "POST" && d) {
        const b = await readBody(req);
        const decision = b.decision;
        if (!["approve", "reject"].includes(decision)) return json(res, 400, { error: "decision 只能是 approve / reject" });
        const t = getTask(db, d[1]);
        if (!t) return json(res, 404, { error: "not found" });
        if (t.state !== "awaiting_human") return json(res, 409, { error: "任务当前状态是 " + t.state + "，不在待评审" });
        if (b.by && t.owner && b.by !== t.owner) return json(res, 403, { error: "只有 owner(" + t.owner + ") 可以裁决" });

        record(db, {
          taskId: t.id, type: "human.decision", actor: b.by || t.owner,
          payload: { decision: decision === "approve" ? "approved" : "rejected", note: b.note || null, by: b.by || t.owner },
        });
        if (b.note) addEvidence(db, t.id, { last_human_note: b.note }, "evidence.patch");
        if (decision === "reject") {
          record(db, {
            taskId: t.id, type: "attempt.reset", actor: b.by || t.owner,
            payload: { reason: "human 打回：重试额度归零，上一轮证据留给 coder" },
          });
        }
        transition(db, t.id, decision === "approve" ? "merging" : "queued", { actor: b.by || t.owner, reason: "human " + decision });
        return json(res, 200, { task: getTask(db, t.id) });
      }

      if (req.method === "GET") {
        const rel = path === "/" ? "/index.html" : path;
        // 开了口令时，页面也挡住：没登录的人只能看到登录页（静态资源同理，除了登录页自己）
        if (TOKEN && !authed(req) && rel !== "/login.html") {
          res.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
          return res.end();
        }
        const file = join(WEB, rel.replace(/^\.\./, ""));
        if (!file.startsWith(WEB)) return json(res, 403, { error: "forbidden" });
        try {
          const body = await readFile(file);
          res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
          return res.end(body);
        } catch { return json(res, 404, { error: "not found" }); }
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (e) {
      return json(res, 500, { error: String(e && e.message || e) });
    }
  };
}

export function startServer() {
  watchParent({ log: (m) => process.stderr.write("[server] " + m + "\n") });
  const db = openDb();
  const server = createServer(createApp(db));
  server.listen(PORT, HOST, () => {
    process.stdout.write("[server] http://" + HOST + ":" + PORT + (TOKEN ? " (token required)" : "") + "\n");
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server/index.mjs")) {
  startServer();
}
