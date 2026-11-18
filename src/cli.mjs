#!/usr/bin/env node
import { openDb } from "./core/db.mjs";
import { createTask, getTask, listTasks, rebuild } from "./core/ledger.mjs";
import { readForTask } from "./core/events.mjs";
import { getProvider, listProviders } from "./runner/engine.mjs";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];

async function main() {
  const db = openDb();
  if (cmd === "init") {
    process.stdout.write("账本就绪: data/ledger.db\n引擎: " + listProviders().join(", ") + "\n");
    return;
  }
  if (cmd === "enqueue") {
    const t = createTask(db, {
      title: arg("title"),
      repo: arg("repo", "sandbox/demo"),
      owner: arg("owner", process.env.USER || "unknown"),
      budgetTokens: Number(arg("budget", 200000)),
    });
    process.stdout.write(t.id + "\n");
    return;
  }
  if (cmd === "status") {
    const id = arg("id");
    if (id) {
      const t = getTask(db, id);
      if (!t) { process.stdout.write("不存在\n"); return; }
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
      for (const e of readForTask(db, id)) {
        process.stdout.write("  " + e.id + " " + e.ts + " " + e.type + " " + e.payload + "\n");
      }
      return;
    }
    for (const t of listTasks(db, { limit: 50 })) {
      process.stdout.write([t.id, t.state.padEnd(14), String(t.attempts).padStart(2), t.spent_tokens + "/" + t.budget_tokens, t.owner.padEnd(10), t.title].join("  ") + "\n");
    }
    return;
  }
  if (cmd === "rebuild") {
    process.stdout.write("重建投影，任务数: " + rebuild(db) + "\n");
    return;
  }
  if (cmd === "run") {
    const { pump } = await import("./runner/worker.mjs");
    const provider = await getProvider(process.env.WB_ENGINE || "mock");
    await pump(db, { workerId: arg("worker", "cli-" + process.pid), provider, once: process.argv.includes("--once") });
    return;
  }
  if (cmd === "serve") {
    const { startServer } = await import("./server/index.mjs");
    startServer();
    return;
  }
  process.stdout.write("用法: cli.mjs <init|enqueue|status|rebuild|run|serve>\n");
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
