import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { openDb } from "../src/core/db.mjs";
import { createTask } from "../src/core/ledger.mjs";
import {
  createUser, ensureLegacyOwners, getUser, hashPassword, listUsers, publicUser,
  readSession, ROLES, sessionUser, setActive, setPassword, setRole, signSession, tempPassword, verifyPassword,
} from "../src/core/users.mjs";

const freshDb = () => openDb(resolve(mkdtempSync(join(tmpdir(), "wb-users-")), "t.db"));

test("口令哈希：scrypt 格式，能验对错口令，且不同次哈希不同（有盐）", () => {
  const h1 = hashPassword("correct-horse");
  const h2 = hashPassword("correct-horse");
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, h2, "同一个口令两次哈希必须不同（随机盐）");
  assert.equal(verifyPassword("correct-horse", h1), true);
  assert.equal(verifyPassword("wrong", h1), false);
  assert.equal(verifyPassword("correct-horse", null), false, "没有口令的账号不能靠空口令登录");
  assert.throws(() => hashPassword("123"), /至少 6 位/);
});

test("账号：重名拒绝，角色只认 lead/member/viewer，公开形状不含哈希", () => {
  const db = freshDb();
  const u = createUser(db, { name: "alice", role: "member", password: "secret1" });
  assert.equal(u.role, "member");
  assert.throws(() => createUser(db, { name: "alice", role: "member", password: "secret1" }), /已存在/);
  assert.throws(() => createUser(db, { name: "bob", role: "god", password: "secret1" }), /角色只能/);
  const p = publicUser(getUser(db, "alice"));
  assert.equal(p.password_hash, undefined);
  assert.equal(p.hasPassword, true);
  assert.deepEqual(ROLES, ["lead", "member", "viewer"]);
});

test("会话：签名可验，改一个字节就失效，过期也失效", () => {
  const secret = "s".repeat(32);
  const cookie = signSession(secret, { name: "alice", role: "member", version: 1 });
  assert.equal(readSession(secret, cookie).n, "alice");
  const tampered = cookie.slice(0, -2) + (cookie.endsWith("aa") ? "bb" : "aa");
  assert.equal(readSession(secret, tampered), null, "篡改 payload 必须验签失败");
  assert.equal(readSession("other-secret", cookie), null);
  const expired = signSession(secret, { name: "alice", role: "member", version: 1, ttlSeconds: -1 });
  assert.equal(readSession(secret, expired), null, "过期 cookie 必须失效");
});

test("改口令/改角色会踢掉旧登录（secret_version 递增）", () => {
  const db = freshDb();
  const secret = "k".repeat(32);
  const u = createUser(db, { name: "alice", role: "member", password: "secret1" });
  const cookie = signSession(secret, { name: u.name, role: u.role, version: u.secret_version });
  assert.equal(sessionUser(db, secret, cookie).name, "alice");

  setPassword(db, "alice", "secret2");
  assert.equal(sessionUser(db, secret, cookie), null, "改口令后旧 cookie 必须失效");

  const u2 = getUser(db, "alice");
  const cookie2 = signSession(secret, { name: u2.name, role: u2.role, version: u2.secret_version });
  assert.equal(sessionUser(db, secret, cookie2).name, "alice");
  setRole(db, "alice", "lead");
  assert.equal(sessionUser(db, secret, cookie2), null, "改角色也要重新登录");
});

test("停用账号：立刻不能登录；最后一个 lead 不能被停用", () => {
  const db = freshDb();
  createUser(db, { name: "boss", role: "lead", password: "secret1" });
  createUser(db, { name: "bob", role: "member", password: "secret1" });
  setActive(db, "bob", false);
  assert.equal(getUser(db, "bob").active, 0);
  assert.throws(() => setActive(db, "boss", false), /最后一个 lead/);
});

test("老账本 owner 迁移：锁住的同名账号，第一个给 lead，不用人编口令", () => {
  const db = freshDb();
  createTask(db, { title: "x", repo: "/tmp/r", owner: "liujie" });
  createTask(db, { title: "y", repo: "/tmp/r", owner: "wang" });
  const created = ensureLegacyOwners(db);
  assert.deepEqual(created.sort(), ["liujie", "wang"]);
  const lj = getUser(db, "liujie");
  assert.equal(lj.role, "lead");
  assert.equal(lj.password_hash, null, "不替人编口令：没设口令就登不进来");
  assert.equal(lj.active, 0);
  assert.equal(getUser(db, "wang").role, "member");
  assert.deepEqual(ensureLegacyOwners(db), [], "幂等：第二次不再建");
  assert.equal(listUsers(db).length, 2);
});

test("一次性口令：长度够、去掉容易看错的字符", () => {
  const pw = tempPassword(14);
  assert.equal(pw.length, 14);
  assert.doesNotMatch(pw, /[0O1lI]/);
  assert.notEqual(tempPassword(14), tempPassword(14));
});
