/**
 * AES-256-GCM 凭据加密
 *
 * 用于加密 SQLite 中存储的 cookie / 流媒体密码等敏感字段，
 * 替代桌面端 Electron 的 safeStorage.encryptString()。
 *
 * 密钥来源（优先级）：
 *   1. 环境变量 SPLAYER_SECRET_KEY（hex 编码，64 字符 = 32 字节）
 *      —— 多容器共享密钥时使用
 *   2. data/secret.key 文件（首启随机生成，权限 0600）
 *      —— 单容器独占，文件丢失需重新登录
 *
 * 密文格式：enc:v1:<iv_hex>:<tag_hex>:<ct_hex>
 *   - 版本号便于将来升级算法
 *   - hex 编码避免 base64 padding 问题
 *
 * 安全说明：
 *   - GCM 模式自带完整性校验，篡改即解密失败
 *   - 每次加密随机 iv，相同明文产生不同密文
 *   - 密钥文件权限 0600，仅当前用户可读
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths";
import { serverLog } from "./logger";

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM 推荐 96 位
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

/** 解析或派生 32 字节密钥 */
const loadKey = (): Buffer => {
  if (cachedKey) return cachedKey;

  // 1. 环境变量优先（hex 编码）
  const envKey = process.env.SPLAYER_SECRET_KEY;
  if (envKey) {
    // hex 直接解码
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      cachedKey = Buffer.from(envKey, "hex");
      serverLog.info("[crypto] 使用 SPLAYER_SECRET_KEY 环境变量密钥");
      return cachedKey;
    }
    // 非 hex 字符串：用 scrypt 派生（兼容人类可读密码）
    cachedKey = scryptSync(envKey, "splayer-salt-v1", KEY_LEN);
    serverLog.info("[crypto] 使用 SPLAYER_SECRET_KEY 派生密钥");
    return cachedKey;
  }

  // 2. 密钥文件
  const keyPath = path.join(dataRoot, "secret.key");
  try {
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath);
      if (raw.length === KEY_LEN) {
        cachedKey = Buffer.from(raw);
        serverLog.info("[crypto] 从 secret.key 加载密钥");
        return cachedKey;
      }
      serverLog.warn("[crypto] secret.key 长度异常，重新生成");
    }
  } catch (err) {
    serverLog.warn("[crypto] 读取 secret.key 失败，重新生成:", err);
  }

  // 生成新密钥
  const newKey = randomBytes(KEY_LEN);
  try {
    if (!existsSync(dataRoot)) mkdirSync(dataRoot, { recursive: true });
    writeFileSync(keyPath, newKey, { mode: 0o600 });
    chmodSync(keyPath, 0o600); // 双保险
    serverLog.info(`[crypto] 生成新密钥: ${keyPath}`);
  } catch (err) {
    serverLog.error("[crypto] 密钥文件写入失败，本次使用内存密钥:", err);
  }
  cachedKey = newKey;
  return newKey;
};

/**
 * 加密字符串
 * @param plaintext 明文
 * @returns 形如 enc:v1:<iv>:<tag>:<ct> 的密文
 */
export const encryptString = (plaintext: string): string => {
  if (plaintext === "") return ""; // 空串不加密，保持原样
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
};

/**
 * 解密字符串
 * @param ciphertext 形如 enc:v1:<iv>:<tag>:<ct> 的密文
 * @returns 明文；若输入非加密格式（明文存量数据），原样返回（向后兼容）
 */
export const decryptString = (ciphertext: string): string => {
  if (ciphertext === "") return "";
  // 非 enc:v1: 前缀：视为历史明文数据，原样返回（向后兼容）
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;
  const rest = ciphertext.slice(PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 3) {
    serverLog.warn("[crypto] 密文格式异常，原样返回");
    return ciphertext;
  }
  const [ivHex, tagHex, ctHex] = parts;
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const ct = Buffer.from(ctHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    serverLog.error("[crypto] 解密失败:", err);
    return "";
  }
};

/** 判断字符串是否为加密格式（用于调试 / 迁移检测） */
export const isEncrypted = (s: string): boolean => s.startsWith(PREFIX);
