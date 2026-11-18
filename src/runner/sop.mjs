/**
 * 角色 SOP。三条铁律写在提示词里，也写在代码里（不传验证者的 coder 上下文）：
 * 1. Verifier 必须是独立实例，只拿 diff + 真实测试输出，不拿 Coder 的推理。
 * 2. Agent Reviewer 只上抛证据裁决不了的事。
 * 3. 人只回答"要不要合"。
 */

const RULES = [
  "你在一个自动化的团队编程工作台里工作，人是最终 reviewer。",
  "禁止修改或删除已存在的测试文件来让测试通过；那会被判定为 test_weakened 并退回。",
  "禁止用 assert(true) / 空断言 / 被跳过的测试制造伪绿。",
  "只做被分配给你的那一个切片，不要越界重构。",
  "结束时必须输出一个 JSON 代码块，用三个波浪线包围，语言标 json，格式：",
  "~~~json",
  '{"verdict":"pass|fail","summary":"一句话","raised":["需要人裁决的点"]}',
  "~~~",
].join("\n");

export function leadPrompt(task, repoPath) {
  return [RULES, "",
    "## 角色：Lead（拆解者，不写码）",
    "任务标题：" + task.title,
    "目标仓库：" + task.repo + (repoPath ? "（绝对路径 " + repoPath + "，只读参考）" : ""),
    "你现在的工作目录是临时目录：不要在这里写实现，也不要写仓库；只输出拆解结果。",
    "",
    "把任务拆成 1-3 个可独立验证的切片，按依赖顺序排列。",
    "每个切片必须能用一条测试命令判定成败。",
    "只输出切片清单（编号 + 一句话 + 验收方式）。",
  ].join("\n");
}

export function architectPrompt(task, slices, repoPath) {
  return [RULES, "",
    "## 角色：Architect（定边界，不写码）",
    "任务：" + task.title,
    (repoPath ? "目标仓库（只读参考）：" + repoPath : ""),
    "当前目录是临时目录：不要写实现。",
    "", "切片清单：", slices, "",
    "产出一页以内的技术方案，必须包含：模块边界、对外接口签名、失败模式、回滚方式。",
    "不确定的地方标 [待确认]，不要编造。",
  ].join("\n");
}

export function coderPrompt(task, plan, attempt) {
  return [RULES, "",
    "## 角色：Coder（只实现，不自评）",
    "任务：" + task.title,
    "第 " + (attempt + 1) + " 次尝试。",
    "", "## 方案", plan, "",
    "在仓库里完成实现，并补上覆盖该实现的测试。改完自测通过即可。",
    "不要修改既有测试文件来迁就实现。",
  ].join("\n");
}

/** 刻意不传 plan 里的 Coder 过程，只给 diff 与真实命令输出。 */
export function verifierPrompt({ task, diff, testOutput, guards }) {
  return [RULES, "",
    "## 角色：Verifier（独立判卷，与 Coder 不同实例）",
    "任务：" + task.title,
    "", "## 变更 diff", diff.slice(0, 20000),
    "", "## 测试命令的真实输出", testOutput.slice(0, 8000),
    "", "## 机器护栏结论", JSON.stringify(guards.checks, null, 2),
    "",
    "判断这份实现是否真的解决了任务，而不是只让测试变绿。",
    "若护栏已判 fail，你必须判 fail 并说明是哪一条。",
  ].join("\n");
}

export function reviewerPrompt({ task, plan, diff, testOutput, guards }) {
  return [RULES, "",
    "## 角色：Agent Reviewer（只上抛，不做最终决定）",
    "任务：" + task.title,
    "", "## 方案", plan.slice(0, 4000),
    "", "## 变更摘要", diff.slice(0, 12000),
    "", "## 测试输出", testOutput.slice(0, 4000),
    "", "## 护栏", JSON.stringify(guards.checks, null, 2),
    "",
    "只有当证据裁决不了时，才把问题放进 raised 交给人类。",
    "如果证据足够、实现明显正确，verdict 给 pass 且 raised 为空。",
  ].join("\n");
}

/** 从 agent 输出里抠最后一个 JSON verdict 块（支持 ~~~ 与 ``` 两种围栏）。 */
export function parseVerdict(text) {
  const tick = String.fromCharCode(96).repeat(3);
  const re = new RegExp("(?:" + tick + "|~{3})json\\s*([\\s\\S]*?)(?:" + tick + "|~{3})", "g");
  const found = [...String(text).matchAll(re)];
  for (let i = found.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(found[i][1]);
      if (v && typeof v === "object") return v;
    } catch { /* 继续找上一个 */ }
  }
  return null;
}