import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialStatus, importCredentials, ocHomeFor } from "../src/core/credentials.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "wb-cred-"));

function fakeOc() {
  const dir = fresh();
  mkdirSync(join(dir, "config/opencode"), { recursive: true });
  mkdirSync(join(dir, "private"), { recursive: true });
  writeFileSync(join(dir, "config/opencode/opencode.json"), JSON.stringify({ provider: { gptagent: { models: {} }, "other-provider": {} } }));
  writeFileSync(join(dir, "private/provider.env"), "FAKE_KEY=not-a-real-secret\n");
  return dir;
}

test("凭据搬进工作区：配置+密钥就位，provider 名字能体检出来，密钥文件权限收紧", () => {
  const from = fakeOc();
  const ws = fresh();
  const r = importCredentials(from, ws);
  assert.equal(r.ocHome, join(ws, ".oc"));
  assert.deepEqual(r.copied, ["config", "private"]);
  assert.equal(r.providerEnv, true);
  assert.deepEqual(r.providers, ["gptagent", "other-provider"], "只报名字，不含任何密钥");
  assert.equal((statSync(join(ws, ".oc/private/provider.env")).mode & 0o777).toString(8), "600");
  assert.match(readFileSync(join(ws, ".oc/private/provider.env"), "utf8"), /FAKE_KEY/);
  assert.ok(!JSON.stringify(r).includes("not-a-real-secret"), "结果里不许出现密钥");
});

test("没有凭据的工作区：体检说没有，别假装能用", () => {
  const ws = fresh();
  const s = credentialStatus(ws);
  assert.equal(s.providerEnv, false);
  assert.deepEqual(s.providers, []);
  assert.equal(s.ocHome, join(ws, ".oc"));
});

test("opencode 的 HOME 顺序：WB_OC_HOME → <WB_ROOT>/.oc → <cwd>/.oc", () => {
  const before = { oc: process.env.WB_OC_HOME, root: process.env.WB_ROOT };
  try {
    delete process.env.WB_OC_HOME;
    delete process.env.WB_ROOT;
    assert.equal(ocHomeFor(process.cwd()), join(process.cwd(), ".oc"));

    process.env.WB_ROOT = "/tmp/wb-root-x";
    assert.equal(ocHomeFor(), "/tmp/wb-root-x/.oc", "打包后 cwd 在包内，只有落到工作区才读得到凭据");

    process.env.WB_OC_HOME = "/tmp/wb-oc-x";
    assert.equal(ocHomeFor(), "/tmp/wb-oc-x");
  } finally {
    if (before.oc === undefined) delete process.env.WB_OC_HOME; else process.env.WB_OC_HOME = before.oc;
    if (before.root === undefined) delete process.env.WB_ROOT; else process.env.WB_ROOT = before.root;
  }
});
