/**
 * 执行器活体状态。
 *
 * 为什么需要它：worker 是唯一"真的在干活"的那个进程，可它一旦崩了（V8 abort、被系统杀、
 * OOM），账本里没有任何记录 —— 界面看着风平浪静，其实队列已经没人消费了。这就是
 * 「无人值守」最贵的失败：不是任务失败，而是没人发现没人干活。
 *
 * 做法很土但够用：worker 每几秒把 {pid, at, engine, workerId} 写进 data/worker.json，
 * 服务端读这个文件的 mtime/at 判断在线。不落账本（不制造事件噪声），也不依赖进程探测
 * （打包 app 里没有权限 ps 别人的进程）。
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export const STALE_MS = Number(process.env.WB_WORKER_STALE_MS || 20000);

/** worker 侧：开始心跳，返回停止函数。写临时文件再 rename，避免读到半截 JSON。 */
export function startHeartbeat(file, info = {}, intervalMs = Number(process.env.WB_WORKER_BEAT_MS || 5000)) {
  const write = () => {
    const body = JSON.stringify({ pid: process.pid, at: Date.now(), ...info });
    try {
      writeFileSync(file + ".tmp", body);
      renameSync(file + ".tmp", file);
    } catch { /* 写不进去不该拖垮 worker */ }
  };
  write();
  const timer = setInterval(write, intervalMs);
  if (timer.unref) timer.unref();
  return () => { clearInterval(timer); };
}

/** 服务端侧：读心跳文件，返回 {alive, age_s, pid, engine, workerId}。 */
export function readHeartbeat(file, now = Date.now()) {
  try {
    const b = JSON.parse(readFileSync(file, "utf8"));
    const age = Math.max(0, now - Number(b.at || 0));
    return { alive: age <= STALE_MS, age_s: Math.round(age / 1000), pid: b.pid || null, engine: b.engine || null, workerId: b.workerId || null, stale_after_s: Math.round(STALE_MS / 1000) };
  } catch {
    return { alive: false, age_s: null, pid: null, engine: null, workerId: null, stale_after_s: Math.round(STALE_MS / 1000) };
  }
}
