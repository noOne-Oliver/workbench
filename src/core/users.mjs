import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 一人一号。角色是「能做什么」，不是标签——所有判断都在服务端，前端只是不显示按钮。
 * 口令用 node:crypto 的 scrypt（不引依赖）；cookie 用 HMAC 签名（不建 session 表）。
 */
export const ROLES = ["lead", "member", "viewer"];

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 6;

export function hashPassword(pw) {
  const s = String(pw ?? "");
  if (s.length < MIN_PASSWORD) throw new Error("口令至少 " + MIN_PASSWORD + " 位");
  const salt = randomBytes(16);
  const hash = scryptSync(s, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expect = Buffer.from(hashB64, "base64");
  const got = scryptSync(String(pw ?? ""), Buffer.from(saltB64, "base64"), expect.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return got.length === expect.length && timingSafeEqual(got, expect);
}

/** 生成一次性口令（给人转述用，去掉容易看错的 0/O/1/l/I）。 */
export function tempPassword(len = 14) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

const nowIso = () => new Date().toISOString();

export function createUser(db, { name, role = "member", password = null }) {
  const n = String(name ?? "").trim();
  if (!n) throw new Error("用户名必填");
  if (!ROLES.includes(role)) throw new Error("角色只能是 " + ROLES.join(" / "));
  if (db.prepare("SELECT 1 FROM users WHERE name = ?").get(n)) throw new Error("用户已存在: " + n);
  db.prepare("INSERT INTO users (name, role, password_hash, secret_version, active, created_at, updated_at) VALUES (?,?,?,1,1,?,?)")
    .run(n, role, password ? hashPassword(password) : null, nowIso(), nowIso());
  return getUser(db, n);
}

/** 公开形状：绝不把 password_hash 发到前端。 */
export function publicUser(u) {
  if (!u) return null;
  return { name: u.name, role: u.role, active: !!u.active, hasPassword: !!u.password_hash, created_at: u.created_at };
}

export function getUser(db, name) {
  return db.prepare("SELECT * FROM users WHERE name = ?").get(String(name ?? "")) ?? null;
}

export function listUsers(db) {
  return db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, name").all();
}

/**
 * 改口令时 secret_version +1：旧 cookie 里的版本号对不上，全部立刻失效（不用建 session 表也能踢人）。
 */
export function setPassword(db, name, password) {
  const u = getUser(db, name);
  if (!u) throw new Error("用户不存在: " + name);
  db.prepare("UPDATE users SET password_hash=?, secret_version=secret_version+1, active=1, updated_at=? WHERE name=?")
    .run(hashPassword(password), nowIso(), name);
  return getUser(db, name);
}

export function setRole(db, name, role) {
  if (!ROLES.includes(role)) throw new Error("角色只能是 " + ROLES.join(" / "));
  const u = getUser(db, name);
  if (!u) throw new Error("用户不存在: " + name);
  db.prepare("UPDATE users SET role=?, secret_version=secret_version+1, updated_at=? WHERE name=?")
    .run(role, nowIso(), name);
  return getUser(db, name);
}

export function setActive(db, name, active) {
  const u = getUser(db, name);
  if (!u) throw new Error("用户不存在: " + name);
  if (!active && u.role === "lead" && listUsers(db).filter((x) => x.role === "lead" && x.active).length <= 1) {
    throw new Error("最后一个 lead 不能停用");
  }
  db.prepare("UPDATE users SET active=?, secret_version=secret_version+1, updated_at=? WHERE name=?")
    .run(active ? 1 : 0, nowIso(), name);
  return getUser(db, name);
}

/**
 * 老账本里的 owner 是自由字符串。迁移成账号：没有 lead 的给 lead，否则 member；
 * 一律锁住（password_hash 为 NULL），等 lead 用 user passwd 设口令——不替人编口令。
 */
export function ensureLegacyOwners(db) {
  const owners = db.prepare("SELECT DISTINCT owner FROM tasks WHERE owner IS NOT NULL AND owner <> ''").all().map((r) => r.owner);
  const hasLead = listUsers(db).some((u) => u.role === "lead");
  const created = [];
  owners.forEach((name, i) => {
    if (getUser(db, name)) return;
    db.prepare("INSERT INTO users (name, role, password_hash, secret_version, active, created_at, updated_at) VALUES (?,?,NULL,1,0,?,?)")
      .run(name, !hasLead && i === 0 ? "lead" : "member", nowIso(), nowIso());
    created.push(name);
  });
  return created;
}

/**
 * 首次启动兜底：一个能登录的账号都没有时，建一个 lead 并返回一次性口令（只打印一次）。
 * 不替用户静默设密码，也不让系统卡在「没有任何人能登录」。
 */
export function ensureBootstrapAdmin(db, { name = process.env.WB_ADMIN_NAME || process.env.USER || "admin" } = {}) {
  const ready = db.prepare("SELECT 1 FROM users WHERE password_hash IS NOT NULL AND active = 1 LIMIT 1").get();
  if (ready) return null;
  const pw = tempPassword();
  if (getUser(db, name)) {
    setPassword(db, name, pw);
    return { name, password: pw, created: false };
  }
  createUser(db, { name, role: "lead", password: pw });
  return { name, password: pw, created: true };
}

/** 要不要登录：没有账号、也没设 WB_TOKEN 时是本机单机模式（.app 用 WB_NO_AUTH 显式关掉）。 */
export function authEnabled(db) {
  if (process.env.WB_NO_AUTH) return false;
  if (process.env.WB_TOKEN) return true;
  return !!db.prepare("SELECT 1 FROM users WHERE password_hash IS NOT NULL AND active = 1 LIMIT 1").get();
}

/** 会话签名密钥：工作区里的 .wb/session.key（600）。读不到就退到进程内随机（重启即掉线）。 */
export function openSecret(root) {
  const dir = resolve(root, ".wb");
  const file = resolve(dir, "session.key");
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    const s = readFileSync(file, "utf8").trim();
    if (s.length >= 32) return s;
  } catch { /* 只读工作区：退到内存密钥，至少要能登录 */ }
  return process.env.WB_SECRET || randomBytes(32).toString("hex");
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function signSession(secret, { name, role, version = 1, ttlSeconds = 7 * 24 * 3600 }) {
  const payload = { n: name, r: role, v: version, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = b64(JSON.stringify(payload));
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}

export function readSession(secret, value) {
  if (!value || !String(value).includes(".")) return null;
  const [body, sig] = String(value).split(".");
  const expect = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || !p.n || !p.exp || p.exp * 1000 < Date.now()) return null;
  return p;
}

/** cookie -> 当前用户。版本号变了（改口令/改角色/停用）立刻失效。 */
export function sessionUser(db, secret, cookieValue) {
  const p = readSession(secret, cookieValue);
  if (!p) return null;
  const u = getUser(db, p.n);
  if (!u || !u.active || Number(u.secret_version) !== Number(p.v)) return null;
  return publicUser(u);
}
