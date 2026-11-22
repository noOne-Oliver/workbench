/**
 * 看护：worker 挂了要自己拉起来，而且要把"挂过几次"记下来 —— 不然重启一个已经坏掉的
 * 进程只是把崩溃藏起来，人永远不知道执行器在打摆子。
 *
 * 退避策略故意很简单：连续挂了就等 1s → 2s → 4s … 封顶 30s；稳定跑过 60 秒就把计数清零。
 */
export const MAX_BACKOFF_MS = 30000;
export const RESET_AFTER_MS = 60000;

/** 纯函数：连续第 n 次重启前该等多久（n 从 1 开始）。 */
export function backoffMs(consecutiveFailures, cap = MAX_BACKOFF_MS) {
  const n = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(cap, 1000 * 2 ** (n - 1));
}

/**
 * 起一个子进程，退出就按退避重启。返回 {stop, child()}。
 * onExit(code, signal, stats) 用来打日志/上报；返回 stop() 会停掉重启循环并杀掉当前子进程。
 */
export function supervise(spawnChild, { onExit = () => {}, onStart = () => {}, log = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  let child = null;
  let stopped = false;
  let failures = 0;
  let restarts = 0;
  let startedAt = 0;
  let pending = null;

  const start = () => {
    if (stopped) return;
    startedAt = Date.now();
    child = spawnChild();
    onStart(child);
    child.once("exit", (code, signal) => {
      if (stopped) return;
      const ranMs = Date.now() - startedAt;
      if (ranMs > RESET_AFTER_MS) failures = 0;
      failures += 1;
      restarts += 1;
      const wait = backoffMs(failures);
      onExit(code, signal, { ranMs, restarts, failures, waitMs: wait });
      log("子进程退出 code=" + code + " signal=" + signal + " 跑了 " + Math.round(ranMs / 1000) + "s，" + wait + "ms 后重启（第 " + restarts + " 次）");
      pending = timers.setTimeout(() => { pending = null; start(); }, wait);
      if (pending && pending.unref) pending.unref();
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      if (pending) timers.clearTimeout(pending);
      if (child) { try { child.kill("SIGTERM"); } catch {} }
    },
    child: () => child,
    stats: () => ({ restarts, failures }),
  };
}
