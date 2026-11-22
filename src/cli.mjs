#!/usr/bin/env node
import { openDb } from "./core/db.mjs";
import { createTask, getTask, listTasks, rebuild } from "./core/ledger.mjs";
import { readForTask } from "./core/events.mjs";
import { getProvider, listProviders } from "./runner/engine.mjs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { BUILTIN_ENGINES } from "./runner/providers/index.mjs";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];

async function main() {
  const db = openDb();
  if (cmd === "init") {
    process.stdout.write("账本就绪: data/ledger.db\n引擎: " + BUILTIN_ENGINES.join(", ") + "\n");
    return;
  }
  if (cmd === "enqueue") {
    const t = createTask(db, {
      title: arg("title"),
      repo: arg("repo", "sandbox/demo"),
      owner: arg("owner", process.env.USER || "unknown"),
      budgetTokens: Number(arg("budget", process.env.WB_BUDGET || 1_000_000)),
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
    const { watchParent } = await import("./core/orphan.mjs");
    watchParent({ log: (m) => process.stderr.write("[worker] " + m + "\n") });
    const { pump } = await import("./runner/worker.mjs");
    const provider = await getProvider(process.env.WB_ENGINE || "mock");
    await pump(db, { workerId: arg("worker", hostname() + ":" + process.pid), provider, once: process.argv.includes("--once") });
    return;
  }
  if (cmd === "workspace") {
    const { ensureWorkspace } = await import("./core/workspace.mjs");
    const w = ensureWorkspace(arg("dir", process.env.WB_WORKSPACE || join(homedir(), "Workbench")));
    process.stdout.write(JSON.stringify(w) + "\n");
    return;
  }
  if (cmd === "cred") {
    // 凭据只搬不打印：输出里永远只有文件种类和 provider 名字。
    const { credentialStatus, importCredentials } = await import("./core/credentials.mjs");
    const root = arg("dir", process.env.WB_ROOT || process.env.WB_WORKSPACE || process.cwd());
    const sub = process.argv[3];
    if (sub === "import") {
      const from = arg("from");
      if (!from) {
        process.stdout.write("用法: cli.mjs cred import --from <已有 .oc 目录> [--dir <工作区>]\n");
        process.exit(2);
      }
      const r = importCredentials(from, root);
      process.stdout.write(JSON.stringify({ imported: r.copied, ocHome: r.ocHome, providerEnv: r.providerEnv, providers: r.providers }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify(credentialStatus(root)) + "\n");
    return;
  }
  if (cmd === "serve") {
    const { startServer } = await import("./server/index.mjs");
    startServer();
    return;
  }
  process.stdout.write("用法: cli.mjs <init|workspace|cred|enqueue|status|rebuild|run|serve>\n");
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
