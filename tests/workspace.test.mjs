import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureWorkspace } from "../src/core/workspace.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "wb-ws-"));

test("工作区一次建齐：data/worktrees/.oc + 起始仓库，且起始仓库基线是绿的", () => {
  const dir = join(fresh(), "Workbench");
  const w = ensureWorkspace(dir);
  assert.equal(w.root, dir);
  assert.equal(w.db, join(dir, "data", "ledger.db"));
  assert.equal(w.starterRepo, join(dir, "demo"));
  for (const sub of ["data", "worktrees", ".oc"]) assert.ok(existsSync(join(dir, sub)), sub + " 要建出来");

  // 起始仓库必须能真的跑测试：打包后第一件事就是让人提交一个任务，基线红了就全废。
  const pkg = JSON.parse(readFileSync(join(w.starterRepo, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test");
  const run = spawnSync(process.execPath, ["--test"], { cwd: w.starterRepo, encoding: "utf8" });
  assert.equal(run.status, 0, "起始仓库测试要绿：" + run.stdout + run.stderr);

  // 幂等：再调一次不许重建、不许报错。
  const again = ensureWorkspace(dir);
  assert.deepEqual(again.created, []);
  assert.equal(again.starterCreated, false);
});

test("已有仓库存在时只补缺的目录，不覆盖人已经写进去的东西", () => {
  const dir = join(fresh(), "Workbench");
  ensureWorkspace(dir);
  const readme = join(dir, "demo", "README.md");
  assert.ok(existsSync(readme));
  assert.equal(ensureWorkspace(dir).created.includes("demo"), false);
});
