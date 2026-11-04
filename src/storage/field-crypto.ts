/**
 * 敏感字段静态加密（AES-256-GCM）
 *
 * 用途：对落盘 DB 里的敏感列做应用层加密，缓解「裸奔的 main.db 被拷走就全泄」的问题。
 * 密钥来源（优先级）：
 *   1. DB_ENCRYPTION_KEY 环境变量（推荐，部署时注入）
 *   2. 数据目录下的 .dbkey 文件（首次启动自动生成 32 字节随机密钥）
 * 未配置且无法生成时，加密层自动降级为明文（保证可用性，启动日志告警）。
 *
 * 密文格式：v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGO = 'aes-256-gcm';
const KEY_FILE = '.dbkey';
let _key: Buffer | null = null;
let _degraded = false;

function loadKey(): Buffer | null {
  if (_key) return _key;
  const envKey = process.env.DB_ENCRYPTION_KEY;
  if (envKey) {
    // 支持 hex(64) 或 base64(44) 或原始字符串（哈希成32字节）
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) { _key = Buffer.from(envKey, 'hex'); return _key; }
    try { const b = Buffer.from(envKey, 'base64'); if (b.length === 32) { _key = b; return _key; } } catch {}
    _key = crypto.createHash('sha256').update(envKey).digest();
    return _key;
  }
  try {
    const dir = process.env.LINGXI_DATA_DIR || process.cwd();
    const kp = path.join(dir, KEY_FILE);
    if (fs.existsSync(kp)) {
      const hex = fs.readFileSync(kp, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) { _key = Buffer.from(hex, 'hex'); return _key; }
    }
    // 首次生成
    const k = crypto.randomBytes(32);
    fs.writeFileSync(kp, k.toString('hex'), { mode: 0o600 });
    _key = k;
    console.log(`[Crypto] 已生成数据库加密密钥: ${kp}（请妥善备份，丢失则无法解密历史数据）`);
    return _key;
  } catch (e: any) {
    _degraded = true;
    console.warn(`[Crypto] 无法加载/生成密钥，敏感字段将以明文存储: ${e.message}`);
    return null;
  }
}

export function isEncrypted(s: string): boolean {
  return typeof s === 'string' && s.startsWith('v1:');
}

/** 加密明文字段；空值/已加密值原样返回 */
export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain as any;
  if (isEncrypted(plain)) return plain;
  const key = loadKey();
  if (!key) return plain; // 降级明文
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** 解密；非加密格式原样返回（兼容历史明文） */
export function decryptField(cipherText: string | null | undefined): string | null {
  if (cipherText === null || cipherText === undefined || cipherText === '') return cipherText as any;
  if (!isEncrypted(cipherText)) return cipherText; // 历史明文
  const key = loadKey();
  if (!key) { console.warn('[Crypto] 无密钥，无法解密字段'); return null; }
  try {
    const [, ivB64, tagB64, dataB64] = cipherText.split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e: any) {
    console.warn(`[Crypto] 解密失败（密钥不匹配或数据损坏）: ${e.message}`);
    return null;
  }
}

export function cryptoStatus(): { enabled: boolean; degraded: boolean; keySource: string } {
  const k = loadKey();
  return {
    enabled: !!k,
    degraded: _degraded,
    keySource: process.env.DB_ENCRYPTION_KEY ? 'env:DB_ENCRYPTION_KEY' : (k ? `file:${KEY_FILE}` : 'none'),
  };
}
