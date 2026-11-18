import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { openDb } from "../core/db.mjs";
import { createTask, getTask, listTasks, transition, record, addEvidence } from "../core/ledger.mjs";
import { readForTask } from "../core/events.mjs";

const ROOT = resolve(process.env.WB_ROOT || process.cwd());
const WEB = resolve(ROOT, "web");
const TOKEN = process.env.WB_TOKEN || "";
const PORT = Number(process.env.WB_PORT || 7317);
const HOST = process.env.WB_HOST || "127.0.0.1";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers["x-wb-token"] || new URL(req.url, "http://x").searchParams.get("token");
  return h === TOKEN;
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

    if (path.startsWith("/api/") && !authed(req)) return json(res, 401, { error: "unauthorized" });

    try {
      if (req.method === "GET" && path === "/api/tasks") {
        const state = url.searchParams.get("state");
        return json(res, 200, { tasks: listTasks(db, { state: state || null }) });
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
