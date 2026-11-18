let counter = 0;

/** 单调、可读、进程内不重样的任务 id */
export function newId(prefix = "t") {
  const t = Date.now().toString(36);
  const c = (counter++).toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${c}${r}`;
}
