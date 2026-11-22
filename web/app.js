const TOKEN = new URLSearchParams(location.search).get("token") || "";
const api = (p, opts) => fetch(p, {
  ...opts,
  headers: { "content-type": "application/json", ...(TOKEN ? { "x-wb-token": TOKEN } : {}), ...(opts?.headers || {}) },
});

const RUNNING = new Set(["queued", "planning", "implementing", "verifying", "reviewing", "merging"]);
const LABEL = {
  queued: "排队", planning: "拆解中", implementing: "实现中", verifying: "验证中",
  reviewing: "初审中", awaiting_human: "待裁决", merging: "合并中", done: "已完成",
  failed: "失败", blocked: "已阻塞",
};

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const secs = (s) => (s == null ? "" : s < 60 ? s + "s" : Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s");
const hhmmss = (ts) => { try { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return ""; } };

let tasks = [];
let ME = localStorage.getItem("wb_me") || "liujie";
let feed = [];          // 最近的活动事件（升序）
let live = [];          // 每个在跑的任务此刻在做什么
let cursor = 0;         // 增量拉取的游标（事件 id）
let filterTask = null;  // 只看某个任务的时间线

/** 事件 -> 人话。这是"后台在跑什么"的翻译层：没有它，人只能看到状态徽章。 */
function describe(e) {
  const p = e.payload || {};
  switch (e.type) {
    case "task.created": return ["提交", "预算 " + fmt(p.budget_tokens) + (p.owner ? " · owner " + p.owner : "")];
    case "task.transition": return ["状态", (LABEL[p.from] || p.from) + " → " + (LABEL[p.to] || p.to) + (p.reason ? "（" + p.reason + "）" : "")];
    case "attempt.started": return ["尝试", "第 " + (Number(p.attempt) + 1) + " 次"];
    case "attempt.resumed": return ["续跑", "崩溃后接着第 " + (Number(p.attempt) + 1) + " 次（不烧重试额度）"];
    case "attempt.reset": return ["重置", p.reason || "重试额度归零"];
    case "plan.produced": return ["方案", p.plan_md ? String(p.plan_md).length + " 字" : "已产出"];
    case "slices.produced": return ["切片", p.slices ? String(p.slices).length + " 字" : "已产出"];
    case "impl.produced": return ["实现", p.diff_stat || "已提交"];
    case "verify.result": {
      const v = (p.verify && p.verify.verdict) || {};
      const g = (p.verify && p.verify.guards) || [];
      return ["验证", "护栏 " + g.filter((c) => c.ok).length + "/" + g.length + " · Verifier " + (v.verdict || "?")];
    }
    case "review.result": {
      const v = (p.review && p.review.verdict) || {};
      return ["初审", (v.verdict || "?") + (v.summary ? "：" + v.summary : "")];
    }
    case "agent.started": return ["开工", p.role + " · 提示 " + fmt(p.prompt_chars) + " 字"];
    case "agent.finished": return ["完成", p.role + " · " + fmt(p.tokens) + " tok · " + (p.ms >= 1000 ? Math.round(p.ms / 1000) + "s" : p.ms + "ms") + (p.ok ? "" : " · 失败")];
    case "budget.spent": return ["预算", "+" + fmt(p.tokens) + " tok" + (p.detail && p.detail.role ? " · " + p.detail.role : "")];
    case "run.error": return ["错误", p.error || ""];
    case "human.decision": return ["人", p.decision + (p.note ? "：" + p.note : "")];
    case "merge.done": return ["合并", String(p.sha || "").slice(0, 7)];
    case "lease.acquired": return ["租约", "被 " + (p.owner || "?") + " 认领"];
    case "lease.released": return ["租约", "释放"];
    case "lease.lost": return ["租约", "丢失，被别的 worker 接手"];
    case "evidence.patch": return ["证据", "更新"];
    default: return [e.type, ""];
  }
}

function diffBlock(diff) {
  const lines = String(diff).split("\n");
  const shown = lines.slice(0, 400).map((ln) => {
    const cls = ln.startsWith("+++") || ln.startsWith("---") ? "f"
      : ln.startsWith("+") ? "a"
      : ln.startsWith("-") ? "d"
      : ln.startsWith("@@") ? "h" : "";
    return '<span class="dl ' + cls + '">' + esc(ln) + "</span>";
  }).join("");
  const more = lines.length > 400 ? '<span class="dl h">… 还有 ' + (lines.length - 400) + " 行</span>" : "";
  return shown + more;
}

async function load() {
  try {
    const r = await api("/api/tasks");
    const j = await r.json();
    tasks = j.tasks || [];
    render();
  } catch (e) {
    el("clock").textContent = "连接失败: " + e.message;
  }
}

/** 卡片上的"此刻"：跑的是哪个角色、多久了、是不是已经没动静了。 */
function liveLine(t) {
  const l = live.find((x) => x.taskId === t.id);
  if (!l) return "";
  const dead = l.stalled ? ' <span class="badge bad">⚠ ' + l.silent_s + "s 无事件，worker 可能已停</span>" : "";
  if (l.role) {
    return '<div class="row live"><span class="dot"></span><b>' + esc(l.role) + "</b> 正在跑 · 已 " + esc(secs(l.elapsed_s)) + dead + "</div>";
  }
  if (l.last_type) {
    const d = describe({ type: l.last_type, payload: {} });
    return '<div class="row live"><span class="dot idle"></span>最近：' + esc(d[0]) + (l.silent_s != null ? " · " + esc(secs(l.silent_s)) + " 前" : "") + dead + "</div>";
  }
  return "";
}

function card(t, actionable) {
  const ev = t.evidence || {};
  const v = ev.verify || {};
  const rv = ev.review || {};
  const checks = (v.guards || []).map((c) =>
    '<li class="' + (c.ok ? "yes" : "no") + '">' + (c.ok ? "✓ " : "✗ ") + esc(c.id) + " — " + esc(c.detail) + "</li>").join("");
  const raised = (rv.raised || []).map((x) => "<li>" + esc(x) + "</li>").join("");
  return '<div class="card ' + (actionable ? "awaiting" : "") + '">' +
    "<h3>" + esc(t.title) + "</h3>" +
    '<div class="row"><span class="badge">' + (LABEL[t.state] || t.state) + "</span>" +
      "<span>owner: " + esc(t.owner) + "</span>" +
      "<span>尝试 " + t.attempts + "</span>" +
      "<span>预算 " + fmt(t.spent_tokens) + "/" + fmt(t.budget_tokens) + "</span>" +
      (t.review_seconds != null ? "<span>上轮评审 " + t.review_seconds + "s</span>" : "") +
    "</div>" +
    liveLine(t) +
    (t.diff_stat ? '<div class="row mono">' + esc(t.diff_stat) + "</div>" : "") +
    (v.verdict ? '<div class="row">Verifier: <span class="badge ' + (v.passed ? "ok" : "bad") + '">' + esc(v.verdict.summary || "") + "</span></div>" : "") +
    (checks ? '<details><summary>机器护栏 (' + (v.guards || []).filter((c) => c.ok).length + "/" + (v.guards || []).length + ')</summary><ul class="checks">' + checks + "</ul></details>" : "") +
    (raised ? '<div class="row">初审上抛：</div><ul class="raised">' + raised + "</ul>" : "") +
    (v.diff ? '<details open><summary>改动 diff</summary><pre class="diff">' + diffBlock(v.diff) + "</pre></details>" : "") +
    (v.testOutputTail ? '<details><summary>测试输出</summary><pre>' + esc(v.testOutputTail) + "</pre></details>" : "") +
    (ev.last_error ? '<div class="row" style="color:var(--bad)">最近错误: ' + esc(ev.last_error) + "</div>" : "") +
    (actionable && t.owner && ME !== t.owner ?
      '<div class="row" style="color:var(--warn)">这个任务归 ' + esc(t.owner) + " 裁决，当前身份是 " + esc(ME) + "（右上角可改）</div>" : "") +
    (actionable ?
      '<textarea id="note-' + t.id + '" placeholder="批注（reject 时建议写清哪里不对）"></textarea>' +
      '<div class="actions">' +
      '<button class="primary" onclick="decide(\'' + t.id + '\',\'approve\')">通过并合并</button>' +
      '<button class="danger" onclick="decide(\'' + t.id + '\',\'reject\')">打回重做</button>' +
      '<button class="ghost" onclick="watch(\'' + t.id + '\')">看时间线</button>' +
      "</div>" : "") +
    "</div>";
}

function render() {
  const awaiting = tasks.filter((t) => t.state === "awaiting_human");
  const running = tasks.filter((t) => RUNNING.has(t.state));
  const done = tasks.filter((t) => ["done", "failed", "blocked"].includes(t.state));

  el("awaiting").innerHTML = awaiting.length ? awaiting.map((t) => card(t, true)).join("") : '<div class="empty">没有待裁决的任务</div>';
  el("running").innerHTML = running.length ? running.map((t) => card(t, false)).join("") : '<div class="empty">后台空闲</div>';
  el("done").innerHTML = done.length ? done.slice(0, 20).map((t) => card(t, false)).join("") : '<div class="empty">暂无归档</div>';

  el("n-await").textContent = awaiting.length;
  el("n-run").textContent = running.length;
  el("n-done").textContent = done.length;
  el("clock").textContent = "更新于 " + new Date().toLocaleTimeString();
}

function renderFeed() {
  const box = el("events");
  if (!box) return;
  // 心跳只用来判断"还活着"，逐条刷屏没意义；卡片上的计时器已经在走。
  const rows = feed.filter((e) => e.type !== "agent.heartbeat");
  box.innerHTML = rows.length ? rows.slice(-200).map((e) => {
    const d = describe(e);
    return '<li><time>' + esc(hhmmss(e.ts)) + "</time>" +
      (filterTask ? "" : '<span class="who">' + esc(e.title || (e.taskId || "系统")) + "</span>") +
      '<span class="tag">' + esc(d[0]) + "</span>" +
      '<span class="det">' + esc(d[1]) + "</span></li>";
  }).join("") : '<li class="empty">还没有事件</li>';
  el("n-act").textContent = String(rows.length);

  const chip = el("filter-chip");
  if (chip) {
    if (filterTask) {
      const t = tasks.find((x) => x.id === filterTask);
      chip.textContent = "只看：" + (t ? t.title : filterTask) + " ✕";
      chip.style.display = "";
    } else {
      chip.style.display = "none";
    }
  }
  // 跟着最新一条走，除非用户在往上翻历史；首屏（刚填满 160 条）必须直接落到底
  const first = box.dataset.init !== "1";
  box.dataset.init = "1";
  const near = first || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (near) box.scrollTop = box.scrollHeight;
}

async function loadFeed() {
  try {
    let q = "/api/activity?limit=160";
    if (filterTask) q += "&task=" + encodeURIComponent(filterTask);
    if (cursor) q += "&since=" + cursor;
    const r = await api(q);
    if (!r.ok) return;
    const j = await r.json();
    live = j.live || [];
    if (!cursor) feed = j.events || [];
    else if ((j.events || []).length) feed = feed.concat(j.events);
    cursor = j.cursor || cursor;
    if (feed.length > 600) feed = feed.slice(-600);
    renderFeed();
    render();
  } catch { /* 服务端暂时不可达：保持上一帧，别把界面刷成错误页 */ }
}

window.watch = function (id) {
  filterTask = filterTask === id ? null : id;
  feed = [];
  cursor = 0;
  loadFeed();
};
window.clearFilter = function () { filterTask = null; feed = []; cursor = 0; loadFeed(); };

window.decide = async function (id, decision) {
  const note = (document.getElementById("note-" + id) || {}).value || "";
  const r = await api("/api/tasks/" + id + "/decision", {
    method: "POST",
    body: JSON.stringify({ decision, note, by: ME }),
  });
  const j = await r.json();
  if (!r.ok) alert(j.error || "操作失败");
  await load();
  await loadFeed();
};

const meInput = el("me");
if (meInput) {
  meInput.value = ME;
  meInput.addEventListener("change", () => {
    ME = meInput.value.trim() || "liujie";
    localStorage.setItem("wb_me", ME);
    load();
  });
}

// 新建任务：打包后的 app 没有终端，这里是唯一入口。
async function loadWorkspace() {
  try {
    const r = await api("/api/workspace");
    const w = await r.json();
    const info = el("ws-info");
    if (info) {
      const c = w.credentials || {};
      const cred = w.engine === "mock" ? "假引擎" : (c.providerEnv ? "凭据已就位" + (c.providers && c.providers.length ? "（" + c.providers.join(", ") + "）" : "") : "缺凭据：把 provider.env 放进 " + (w.ocHome || "工作区/.oc") + "/private/");
      info.textContent = "工作区 " + w.root + " · 内核 " + w.code + " · 引擎 " + w.engine + " · " + cred;
    }
    const repo = el("t-repo");
    if (repo && !repo.value) repo.value = w.starterRepo;
  } catch { /* 老内核没有这个接口，忽略 */ }
}

const composeForm = el("new-task");
if (composeForm) {
  composeForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      title: el("t-title").value.trim(),
      repo: el("t-repo").value.trim(),
      owner: ME,
      budgetTokens: Number(el("t-budget").value || 1000000),
    };
    const r = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { alert(j.error || "提交失败"); return; }
    el("t-title").value = "";
    const msg = el("compose-msg");
    if (msg) { msg.textContent = "已提交 " + j.task.id + " · 后台会自动开跑，到待裁决时再找你"; setTimeout(() => { msg.textContent = ""; }, 8000); }
    await load();
    await loadFeed();
  });
}

loadWorkspace();
load();
loadFeed();
setInterval(() => { load(); loadFeed(); }, 2500);
