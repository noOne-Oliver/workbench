/**
 * 引擎接口。换 agent 只改这里，账本/调度/状态机一律不动。
 *   run({ role, prompt, cwd, task, attempt, timeoutMs }) -> { ok, text, tokens, error }
 * 独立性由调用方保证：每个角色一次全新会话，不续上下文。
 */

const registry = new Map();

export function registerProvider(name, factory) {
  registry.set(name, factory);
}

export async function getProvider(name, opts = {}) {
  const f = registry.get(name);
  if (!f) throw new Error("未知引擎: " + name + "（可用: " + [...registry.keys()].join(", ") + "）");
  return await f(opts);
}

export function listProviders() {
  return [...registry.keys()];
}

/** 粗略 token 估算，provider 没回 usage 时兜底。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (String(text).match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.ceil(cjk * 1.7 + (String(text).length - cjk) / 4);
}
