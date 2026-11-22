import { sh } from "../runner/worktree.mjs";

/**
 * 任务体量分级：决定这条任务要不要花「拆解 + 定边界」两次 agent 调用。
 *
 * 为什么要在代码里定、而不是让模型自己说：真实基准（5 单）里每个 agent 调用
 * 光 harness + 推理就要 7~17 万 token，prompt 只有几百字也一样贵。所以省钱唯一的
 * 办法是「少调几次」，而「少调几次」必须是确定性的、可测试的、可审计的规则——
 * 让模型自己判断要不要跳过拆解，等于让省钱的人同时是花钱的人。
 *
 * 分级只影响「机器侧编排」，不影响护栏与人工两段评审：
 * - small：单文件小改动 -> 直接 coder（方案内联）+ verifier，跳过 lead/architect/reviewer
 * - normal：多文件或标题偏长 -> lead（拆解）+ coder + verifier + reviewer（复用 verifier 证据）
 * - large：标题含高危词或仓库很大 -> 完整五段
 *
 * 升级路径：small 第一次没过（attempts > 0）自动降级成 normal，重试时拿到完整的
 * 拆解与架构方案 —— 省钱不能省掉「第二次机会的质量」。
 */
export const SIZES = ["small", "normal", "large"];

/** 需要先想清楚再动手的信号：出现就说明「单文件小改」的判断不成立。 */
const HEAVY = /重构|迁移|架构|设计文档|多个模块|全部|批量|升级|清理|并发|安全|性能|协议|接口不兼容/;

/** 标题里点名的源码文件。 */
const FILE_HINT = /[A-Za-z0-9_.\-/]+\.(?:mjs|cjs|js|jsx|ts|tsx|vue|py|go|rs|java|kt|swift|rb|php|sql|sh|css|html)/g;

export function classifySize(task, { repoFiles = 0 } = {}) {
  const title = String((task && task.title) || "").trim();
  const files = title.match(FILE_HINT) || [];
  const heavy = title.match(HEAVY);

  if (heavy) return { size: "large", files, reason: "标题里有「" + heavy[0] + "」，需要先定边界" };
  if (repoFiles > 40) return { size: "large", files, reason: "仓库有 " + repoFiles + " 个文件，上下文成本高，走完整流水线" };
  if (files.length > 1) return { size: "normal", files, reason: "涉及 " + files.length + " 个文件" };
  if (title.length > 120) return { size: "normal", files, reason: "标题 " + title.length + " 字，需求本身需要拆解" };
  return { size: "small", files, reason: "单文件小改动（" + (files[0] || "未点名文件") + "）" };
}

/** 仓库文件数（用于「仓库太大就别省拆解」的阈值）。非 git 仓库返回 0，交给后续报错。 */
export function repoFileCount(repoAbs) {
  const r = sh("git", ["-C", repoAbs, "ls-files"]);
  if (!r.ok) return 0;
  return String(r.out || "").split("\n").filter(Boolean).length;
}
