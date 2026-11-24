import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生成 README 里的示意图（纯手写 SVG，零依赖）。
 *   docs/arch.svg     桌面版四层架构：人 / .app（外壳 + 内核）/ 工作区 / worker + 引擎
 *   docs/install.svg  从下载到第一个任务的五步，以及起不来时怎么查
 *   docs/flow.svg     任务状态机（与内核同源，两个人工闸口）
 *   docs/cost.svg     砍掉多余编排后的成本对比
 *
 * 为什么手写 SVG 而不是截图：图里的每个字都能改、能被 diff、能在深色 README 里直接放大；
 * 而且校验脚本能算出每个 text 的 bbox，防止文字越界或互相压住（见 README「图文怎么验收」）。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs");
mkdirSync(OUT, { recursive: true });

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const C = {
  bg: "#0b0f14",
  panel: "#101821",
  panel2: "#0f151c",
  line: "#22303f",
  text: "#e6edf3",
  muted: "#8b9bad",
  cyan: "#38bdf8",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
  violet: "#a78bfa",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function head(w, h, title) {
  const markers = Object.entries({ cyan: C.cyan, green: C.green, amber: C.amber, red: C.red, muted: C.muted, violet: C.violet })
    .map(([k, v]) => '<marker id="a-' + k + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + v + '"/></marker>')
    .join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" font-family="' + FONT + '" role="img" aria-label="' + esc(title) + '">' +
    '<defs>' + markers + '</defs>' +
    '<rect width="' + w + '" height="' + h + '" fill="' + C.bg + '"/>';
}

function text(x, y, s, o = {}) {
  const size = o.size || 15;
  const fill = o.fill || C.text;
  const anchor = o.anchor || "start";
  const weight = o.weight || 400;
  const mono = o.mono ? " ui-monospace,SFMono-Regular,Menlo,monospace" : "";
  return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + fill + '" text-anchor="' + anchor + '" font-weight="' + weight + '"' +
    (mono ? ' font-family="ui-monospace,SFMono-Regular,Menlo,monospace"' : "") + '>' + esc(s) + "</text>";
}

function box(x, y, w, h, o = {}) {
  const fill = o.fill || C.panel2;
  const stroke = o.stroke || C.line;
  const rx = o.rx === undefined ? 12 : o.rx;
  const dash = o.dash ? ' stroke-dasharray="6 5"' : "";
  const sw = o.sw || 1.2;
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + rx + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + dash + "/>";
}

function line(x1, y1, x2, y2, o = {}) {
  const color = o.color || C.muted;
  const sw = o.sw || 1.6;
  const dash = o.dash ? ' stroke-dasharray="' + (o.dash === true ? "7 6" : o.dash) + '"' : "";
  const marker = o.arrow === false ? "" : ' marker-end="url(#a-' + (o.kind || "muted") + ')"';
  return '<path d="' + (o.d || ("M" + x1 + "," + y1 + " L" + x2 + "," + y2)) + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '"' + dash + marker + "/>";
}

/* ---------------- 1. 架构：内核装进 app，数据留在你的目录 ---------------- */
function arch() {
  const W = 1180, H = 784;
  let s = head(W, H, "桌面版架构");
  s += text(44, 58, "桌面版架构：内核装进 .app，数据留在你自己的目录", { size: 25, weight: 700 });
  s += text(44, 88, "双击打开就有一个窗口；不用终端、不用装 node、不用云账号。关掉窗口任务也不会停，worker 还在后台跑", { size: 14.5, fill: C.muted });

  // 第一层：人
  s += box(300, 120, 580, 88, { fill: C.panel, stroke: C.cyan });
  s += text(590, 152, "人（一个窗口，没有终端）", { size: 17, weight: 600, anchor: "middle", fill: C.cyan });
  s += text(590, 176, "提交一句话任务 · 初筛 30 秒 · 终审要不要合", { size: 13.5, anchor: "middle", fill: C.muted });
  s += text(590, 196, "其余时间窗口可以关掉，任务照跑", { size: 13, anchor: "middle", fill: C.muted });
  s += line(590, 208, 590, 250, { kind: "cyan" });
  s += text(604, 235, "WKWebView 里就是同一个页面", { size: 12.5, fill: C.cyan });

  // 第二层：.app 外框，里面是外壳 + 内核
  s += box(110, 252, 960, 192, { fill: "#0d141c", stroke: C.line });
  s += text(134, 280, "Workbench.app —— 一个包，双击即用（macOS 13+ / Apple Silicon）", { size: 15, weight: 600, fill: C.muted });

  s += box(134, 296, 420, 126, { fill: C.panel, stroke: C.cyan });
  s += text(154, 322, "Swift 外壳 apps/macshell", { size: 15.5, weight: 600, fill: C.cyan });
  s += text(154, 348, "窗口 = WKWebView，界面一行没重写", { size: 13, fill: C.muted });
  s += text(154, 370, "首次启动选工作区，记进 UserDefaults", { size: 13, fill: C.muted });
  s += text(154, 392, "只起自己起的两个子进程，退出全收干净", { size: 13, fill: C.muted });
  s += text(154, 412, "⌘R 重连 · ⌘O 开数据目录 · ⌘Q 退出", { size: 12.5, fill: C.muted });

  s += line(560, 358, 596, 358, { kind: "green" });
  s += text(578, 348, "spawn", { size: 11.5, fill: C.green, anchor: "middle", mono: true });

  s += box(600, 296, 446, 126, { fill: C.panel, stroke: C.violet });
  s += text(620, 322, "打包的内核 Contents/Resources/kernel", { size: 15.5, weight: 600, fill: C.violet });
  s += text(620, 348, "node + src/ + web/ 全在包里 → 不需要装 node", { size: 13, fill: C.muted });
  s += text(620, 370, "离仓可运行：拷到 /tmp 或 /Applications 都能跑", { size: 13, fill: C.muted });
  s += text(620, 392, "ad-hoc 签名，只在本机可信（没公证）", { size: 13, fill: C.muted });
  s += text(620, 412, "同一份内核也能当 Web 服务跑 = 团队版", { size: 12.5, fill: C.muted });

  // 第三层：工作区
  s += line(590, 444, 590, 492, { kind: "amber" });
  s += text(604, 470, "WB_ROOT / WB_DB 指到这里", { size: 12.5, fill: C.amber });

  s += box(240, 494, 700, 112, { fill: C.panel, stroke: C.amber });
  s += text(262, 524, "工作区（数据在这，不在 app 里）", { size: 17, weight: 600, fill: C.amber });
  s += text(262, 548, "~/Workbench：data/ledger.db（事件账本）· worktrees/ · .oc/（引擎凭据）· demo/（起始仓库）", { size: 13, fill: C.muted });
  s += text(262, 570, "外壳启动前只补缺、不覆盖：删了 app 账本还在，换机器就是拷这个目录", { size: 13, fill: C.muted });
  s += text(262, 592, "账本只追加：kill -9 之后重放，不失忆、不乱序、不重复扣钱", { size: 13, fill: C.muted });

  // 第四层：worker + 引擎
  s += line(430, 606, 430, 630, { kind: "green" });
  s += text(444, 624, "领任务 / 落事件", { size: 12, fill: C.green });
  s += line(830, 606, 830, 630, { kind: "amber" });
  s += text(844, 624, "改动只在 worktree", { size: 12, fill: C.amber });

  s += box(150, 634, 400, 106, { fill: C.panel, stroke: C.green });
  s += text(172, 662, "worker（常驻，崩了自动拉起）", { size: 16, weight: 600, fill: C.green });
  s += text(172, 686, "状态机 · 重试 ≤3 轮 · 预算熔断 · 体量分级", { size: 13, fill: C.muted });
  s += text(172, 708, "每次调用落 started / heartbeat / finished 三条事件", { size: 13, fill: C.muted });
  s += text(172, 728, "界面靠心跳分得清「模型在思考」和「worker 已死」", { size: 12, fill: C.muted });

  s += line(556, 687, 602, 687, { kind: "cyan" });
  s += text(579, 678, "一个角色", { size: 11.5, fill: C.cyan, anchor: "middle" });
  s += text(579, 701, "一个进程", { size: 11.5, fill: C.cyan, anchor: "middle" });

  s += box(604, 634, 442, 106, { fill: C.panel, stroke: C.cyan });
  s += text(626, 662, "agent provider（可换）", { size: 16, weight: 600, fill: C.cyan });
  s += text(626, 686, "mock 假引擎 / opencode 真模型（凭据放 .oc/）", { size: 13, fill: C.muted });
  s += text(626, 708, "Verifier 是另一个进程，拿不到 Coder 的上下文", { size: 13, fill: C.muted });
  s += text(626, 728, "确定性失败（权限被拒/欠费）直接停，不空烧额度", { size: 12, fill: C.muted });

  s += text(44, H - 16, "四条不变量：账本只追加 · 单任务单 worker · 改动只在 worktree · 合并必须由人批准", { size: 13, fill: C.muted });
  s += "</svg>";
  return s;
}

/* ---------------- 2. 安装路径 ---------------- */
function install() {
  const W = 1180, H = 560;
  let s = head(W, H, "安装路径");
  s += text(44, 58, "从下载到第一个任务：五步，两步要人动", { size: 25, weight: 700 });
  s += text(44, 88, "没有公证（不花钱买证书），所以第一次必须「右键 → 打开」；之后就是普通的双击", { size: 14.5, fill: C.muted });

  const bw = 199, gap = 24, y = 124, bh = 178;
  const xs = [44, 267, 490, 713, 936];
  const steps = [
    ["1", "拿到 zip", [["Workbench-0.2.0.zip", "mono"], ["11 MB · 内核已打包", ""], ["不需要另装 node", ""]]],
    ["2", "拖进「应用程序」", [["右键 → 打开（首次）", ""], ["双击会被 Gatekeeper 拦", ""], ["或 xattr -dr", "mono"]]],
    ["3", "选一个工作区", [["默认 ~/Workbench", "mono"], ["只问一次，记 UserDefaults", ""], ["取消也不卡启动", ""]]],
    ["4", "自动补齐并起内核", [["data/ worktrees/ .oc/ demo/", "mono"], ["起 server + worker", ""], ["窗口里是收件箱", ""]]],
    ["5", "建任务，等它跑", [["机器实现 + 自己验收", ""], ["到「待初筛/待批准」找你", ""], ["⌘O 开数据目录", ""]]],
  ];
  steps.forEach(([n, title, lines], i) => {
    s += box(xs[i], y, bw, bh, { fill: C.panel, stroke: i < 2 ? C.cyan : C.green });
    s += text(xs[i] + 18, y + 32, n, { size: 20, weight: 700, fill: i < 2 ? C.cyan : C.green });
    s += text(xs[i] + 42, y + 32, title, { size: 14.5, weight: 600 });
    lines.forEach(([t, kind], j) => {
      s += text(xs[i] + 18, y + 66 + j * 30, t, { size: kind === "mono" ? 11.5 : 12.5, fill: C.muted, mono: kind === "mono" });
    });
    if (i < 4) s += line(xs[i] + bw + 4, y + bh / 2, xs[i + 1] - 6, y + bh / 2, { kind: i < 1 ? "cyan" : "green" });
  });

  s += text(xs[0] + bw / 2, y - 14, "要人动手", { size: 12, fill: C.cyan, anchor: "middle", weight: 600 });
  s += text(xs[4] + bw / 2, y - 14, "之后全是后台", { size: 12, fill: C.green, anchor: "middle", weight: 600 });

  // 兜底两条
  s += box(44, 348, 520, 132, { fill: C.panel, stroke: C.amber });
  s += text(66, 378, "起不来怎么查（不用猜）", { size: 15.5, weight: 600, fill: C.amber });
  s += text(66, 404, "~/Library/Logs/Workbench/kernel.log", { size: 12.5, fill: C.muted, mono: true });
  s += text(66, 424, "每行带 [server] / [worker] 前缀，两个进程不搅在一起", { size: 12.5, fill: C.muted });
  s += text(66, 446, "WB_SHELL_SMOKE=1 自检：内核就绪？attach 还是 spawn？", { size: 12.5, fill: C.muted });
  s += text(66, 466, "窗口里也会直接写「端口 7399 被别的服务占着」", { size: 12.5, fill: C.muted });

  s += box(588, 348, 548, 132, { fill: C.panel, stroke: C.violet });
  s += text(610, 378, "想换端口 / 换目录 / 接真引擎", { size: 15.5, weight: 600, fill: C.violet });
  s += text(610, 404, "WB_PORT=7500 WB_WORKSPACE=~/ws open -a Workbench", { size: 12, fill: C.muted, mono: true });
  s += text(610, 424, "凭据放 <工作区>/.oc/：不会进 app 包，也不会进仓库", { size: 12.5, fill: C.muted });
  s += text(610, 446, "WB_ENGINE=opencode 才会真烧 token（默认 mock 不花钱）", { size: 12.5, fill: C.muted });
  s += text(610, 466, "开发期 WB_KERNEL=<仓库> 直接指向源码，不用重打包", { size: 12.5, fill: C.muted });

  s += text(44, H - 16, "装完这一步就可以把终端关掉：进度、心跳、日志、待办全在窗口里；数据在你选的目录里，卸掉 app 不影响账本", { size: 13, fill: C.muted });
  s += "</svg>";
  return s;
}

/* ---------------- 3. 状态机 ---------------- */
function flow() {
  const W = 1180, H = 620;
  let s = head(W, H, "任务状态机");
  s += text(44, 58, "一个任务活多久：机器跑四段，人只卡两关", { size: 25, weight: 700 });
  s += text(44, 88, "两段人工是显式状态，不是「awaiting_human + 一个字段」——账本重放一眼看出卡在哪一关，两段耗时也能分开统计", { size: 14, fill: C.muted });

  const bw = 196, bh = 66, y1 = 130, y2 = 330;
  const xs = [44, 300, 556, 812];
  const row1 = [["queued", "排队"], ["planning", "规划"], ["implementing", "实现"], ["verifying", "验收"]];
  const colors1 = [C.muted, C.violet, C.green, C.cyan];
  row1.forEach(([id, name], i) => {
    s += box(xs[i], y1, bw, bh, { fill: C.panel, stroke: colors1[i] });
    s += text(xs[i] + bw / 2, y1 + 28, name, { size: 16, weight: 600, anchor: "middle", fill: colors1[i] });
    s += text(xs[i] + bw / 2, y1 + 50, id, { size: 12, anchor: "middle", fill: C.muted, mono: true });
    if (i < 3) s += line(xs[i] + bw + 4, y1 + bh / 2, xs[i + 1] - 6, y1 + bh / 2, { kind: colors1[i + 1] });
  });

  s += line(910, y1 + bh + 4, 910, y2 - 6, { kind: "amber" });

  const row2 = [["awaiting_review", "初筛（人）", C.amber], ["awaiting_approval", "终审（人）", C.amber], ["merging", "合并", C.violet], ["done", "完成", C.green]];
  row2.forEach(([id, name, col], i) => {
    const human = i < 2;
    s += box(xs[i], y2, bw, bh, { fill: human ? "#1d1a10" : C.panel, stroke: col, sw: human ? 1.8 : 1.2 });
    s += text(xs[i] + bw / 2, y2 + 28, name, { size: 16, weight: 600, anchor: "middle", fill: col });
    s += text(xs[i] + bw / 2, y2 + 50, id, { size: 12, anchor: "middle", fill: C.muted, mono: true });
    if (i < 3) s += line(xs[i] + bw + 4, y2 + bh / 2, xs[i + 1] - 6, y2 + bh / 2, { kind: col });
  });

  s += text(xs[0] + bw / 2, y2 - 18, "人闸 1", { size: 12.5, fill: C.amber, anchor: "middle", weight: 600 });
  s += text(xs[1] + bw / 2, y2 - 18, "人闸 2", { size: 12.5, fill: C.amber, anchor: "middle", weight: 600 });

  s += line(0, 0, 0, 0, { d: "M" + (xs[0] - 2) + "," + (y2 + bh / 2) + " L" + (xs[0] - 22) + "," + (y2 + bh / 2) + " L" + (xs[0] - 22) + "," + (y1 + bh / 2) + " L" + (xs[0] - 2) + "," + (y1 + bh / 2), kind: "red", dash: true });
  s += text(xs[2] - 10, y2 + bh + 36, "打回（必须写理由）→ 重置 worktree → 重做，人的原话排在下轮提示词第一行", { size: 12.5, fill: C.red, anchor: "end" });

  s += line(0, 0, 0, 0, { d: "M" + (xs[3] + 40) + "," + (y1 + bh + 4) + " C" + (xs[3] + 40) + "," + (y1 + bh + 46) + " " + (xs[2] + 130) + "," + (y1 + bh + 46) + " " + (xs[2] + 130) + "," + (y1 + bh + 4), kind: "red", dash: true });
  s += text(xs[3] - 10, y1 + bh + 34, "护栏 / Verifier 没过：自动重试（≤3 轮）", { size: 12.5, fill: C.red, anchor: "end" });

  s += box(xs[2], y2 + bh + 64, 300, 74, { fill: "#1b1114", stroke: C.red, dash: true });
  s += text(xs[2] + 150, y2 + bh + 92, "blocked 机器认输", { size: 15, weight: 600, anchor: "middle", fill: C.red });
  s += text(xs[2] + 150, y2 + bh + 116, "重试耗尽 · 预算熔断 · 权限被拒（确定性失败不重试）", { size: 12, anchor: "middle", fill: C.muted });
  s += line(0, 0, 0, 0, { d: "M" + (xs[3] + bw - 30) + "," + (y1 + bh + 4) + " L" + (xs[3] + bw - 30) + "," + (y2 + bh + 100) + " L" + (xs[2] + 306) + "," + (y2 + bh + 100), kind: "red", dash: true });
  s += text(xs[3] + bw - 18, y1 + bh + 96, "重试耗尽", { size: 12, fill: C.red });

  s += text(44, H - 22, "只有 awaiting_review / awaiting_approval 会停住等人；其余状态里人可以不看，因为系统会自己重试、自己升级、自己记完", { size: 13, fill: C.muted });
  s += "</svg>";
  return s;
}

/* ---------------- 4. 成本 ---------------- */
function cost() {
  const W = 1180, H = 470;
  let s = head(W, H, "成本对比");
  s += text(44, 58, "同样一套 5 个任务，砍掉多余编排之后", { size: 25, weight: 700 });
  s += text(44, 88, "真引擎实跑（opencode + deepseek-v4.1-flash），单位：token / 单任务平均", { size: 14, fill: C.muted });

  const baseY = 380, maxH = 250, maxV = 700000;
  const bar = (x, w, v, color, label, sub) => {
    const h = Math.round((v / maxV) * maxH);
    let o = '<rect x="' + x + '" y="' + (baseY - h) + '" width="' + w + '" height="' + h + '" rx="6" fill="' + color + '" opacity="0.85"/>';
    o += text(x + w / 2, baseY - h - 12, label, { size: 15, weight: 700, anchor: "middle", fill: color });
    o += text(x + w / 2, baseY + 22, sub, { size: 12.5, anchor: "middle", fill: C.muted });
    return o;
  };
  s += text(60, 130, "① 编排成本：5 次调用 → 2 次调用", { size: 16, weight: 600 });
  s += bar(80, 110, 482743, C.red, "482,743", "旧：5 次调用");
  s += bar(240, 110, 230630, C.green, "230,630", "新：2 次调用");
  s += text(190, 300, "-52.2%", { size: 34, weight: 700, anchor: "middle", fill: C.green });
  s += line(60, baseY, 400, baseY, { color: C.line, arrow: false, sw: 1 });

  s += text(470, 130, "② 不同体量各花多少（同一个真实套件）", { size: 16, weight: 600 });
  s += bar(500, 92, 210118, C.cyan, "21 万", "small 改一处");
  s += bar(636, 92, 514444, C.amber, "51 万", "normal 多文件");
  s += bar(772, 92, 622392, C.violet, "62 万", "large 重构");
  s += line(480, baseY, 950, baseY, { color: C.line, arrow: false, sw: 1 });

  s += text(60, 432, "贵的地方不是提示词长度（每次 prompt 只有几百到几千字），是「调用次数 × 每次自带的工具往返」——所以省钱只能靠少调几次。", { size: 12.5, fill: C.muted });
  s += text(44, H - 16, "报告：docs/bench-real-2026-11-22T13-25-24-476Z.json（6 单混跑：small/normal/large 各走各的路径 + 一次确定性降级）", { size: 12, fill: C.muted });
  s += "</svg>";
  return s;
}

const files = { "arch.svg": arch(), "install.svg": install(), "flow.svg": flow(), "cost.svg": cost() };
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(OUT, name), body, "utf8");
  console.log("write docs/" + name, body.length, "字节");
}
