import fs from "node:fs";
import path from "node:path";

/**
 * 真引擎的凭据/配置只放在**工作区**里（<ws>/.oc），不放进 app 包、也不进仓库。
 * 这里只负责搬运和体检，不解析密钥内容，日志里也绝不打印它。
 */
const PARTS = ["config", "private"];

/** 工作区里 opencode 的 HOME：WB_OC_HOME → <WB_ROOT>/.oc → <cwd>/.oc（和 worker 的解析顺序一致）。 */
export function ocHomeFor(root) {
  return path.resolve(process.env.WB_OC_HOME || path.join(root || process.env.WB_ROOT || process.cwd(), ".oc"));
}

/** 体检：有没有凭据文件、配置里声明了哪些 provider（只有名字，不含密钥）。 */
export function credentialStatus(root) {
  const ocHome = ocHomeFor(root);
  const envFile = path.join(ocHome, "private/provider.env");
  const cfg = path.join(ocHome, "config/opencode/opencode.json");
  const providers = [];
  try {
    const j = JSON.parse(fs.readFileSync(cfg, "utf8"));
    for (const name of Object.keys(j.provider || {})) providers.push(name);
  } catch {
    // 没有/坏了就是没有，交给引擎自己报错
  }
  return { ocHome, providerEnv: fs.existsSync(envFile), providers };
}

/**
 * 把已有的 .oc（config + private）搬进工作区。给打包后的 app 用：
 * 机器上可能没有终端，但总得有人把凭据放进去一次。
 */
export function importCredentials(fromDir, root) {
  const src = path.resolve(fromDir);
  const dst = path.join(root, ".oc");
  if (!fs.existsSync(src)) throw new Error("凭据目录不存在: " + src);
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of PARTS) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dst, name), { recursive: true, force: true });
    copied.push(name);
  }
  // 密钥文件收紧到本人可读
  try { fs.chmodSync(path.join(dst, "private/provider.env"), 0o600); } catch {}
  try { fs.chmodSync(path.join(dst, "private"), 0o700); } catch {}
  return { ocHome: dst, copied, ...credentialStatus(root) };
}
