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

let tasks = [];
let ME = localStorage.getItem("wb_me") || "liujie";

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

function card(t, actionable) {
  const ev = t.evidence || {};
  const v = ev.verify || {};
  const rv = ev.review || {};
  const checks = (v.guards || []).map((c) =>
    '<li class="' + (c.ok ? "yes" : "no") + '">' + (c.ok ? "✓ " : "✗ ") + esc(c.id) + " — " + esc(c.detail) + "</li>").join("");
  const raised = (rv.raised || []).map((x) => "<li>" + esc(x) + "</li>").join("");
  return '<div class="card ' + (actionable ? "awaiting" : "") + '">' +
    '<h3>' + esc(t.title) + "</h3>" +
    '<div class="row"><span class="badge">' + (LABEL[t.state] || t.state) + "</span>" +
      '<span>owner: ' + esc(t.owner) + "</span>" +
      '<span>尝试 ' + t.attempts + "</span>" +
      '<span>预算 ' + t.spent_tokens + "/" + t.budget_tokens + "</span>" +
      (t.review_seconds != null ? "<span>上轮评审 " + t.review_seconds + "s</span>" : "") +
    "</div>" +
    (t.diff_stat ? '<div class="row mono">' + esc(t.diff_stat) + "</div>" : "") +
    (v.verdict ? "<div class=\"row\">Verifier: <span class=\"badge " + (v.passed ? "ok" : "bad") + '">' + esc(v.verdict.summary || "") + "</span></div>" : "") +
    (checks ? '<details><summary>机器护栏 (' + (v.guards || []).filter((c) => c.ok).length + "/" + (v.guards || []).length + ')</summary><ul class="checks">' + checks + "</ul></details>" : "") +
    (raised ? '<div class="row">初审上抛：</div><ul class="raised">' + raised + "</ul>" : "") +
    (v.diff ? '<details open><summary>改动 diff</summary><pre class="diff">' + diffBlock(v.diff) + "</pre></details>" : "") +
    (v.testOutputTail ? '<details><summary>测试输出</summary><pre>' + esc(v.testOutputTail) + "</pre></details>" : "") +
    (ev.last_error ? '<div class="row" style="color:var(--bad)">最近错误: ' + esc(ev.last_error) + "</div>" : "") +
    (actionable && t.owner && ME !== t.owner ?
      '<div class="row" style="color:var(--warn)">这个任务归 ' + esc(t.owner) + ' 裁决，当前身份是 ' + esc(ME) + "（右上角可改）</div>" : "") +
    (actionable ?
      '<textarea id="note-' + t.id + '" placeholder="批注（reject 时建议写清哪里不对）"></textarea>' +
      '<div class="actions">' +
      '<button class="primary" onclick="decide(\'' + t.id + '\',\'approve\')">通过并合并</button>' +
      '<button class="danger" onclick="decide(\'' + t.id + '\',\'reject\')">打回重做</button>' +
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

window.decide = async function (id, decision) {
  const note = (document.getElementById("note-" + id) || {}).value || "";
  const r = await api("/api/tasks/" + id + "/decision", {
    method: "POST",
    body: JSON.stringify({ decision, note, by: ME }),
  });
  const j = await r.json();
  if (!r.ok) alert(j.error || "操作失败");
  await load();
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
  });
}

loadWorkspace();
load();
setInterval(load, 2500);