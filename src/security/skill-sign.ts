/**
 * 技能市场签名验证 — Ed25519 签名 + 清单校验
 *
 * 设计：
 * - 市场发布的每个技能包是一个 zip，内含 SKILL.md + manifest.json
 * - manifest.json 含 { name, version, files: [{path, sha256}], signature }
 * - signature = Ed25519 签名（对 canonical JSON of {name,version,files}）
 * - 公钥来自 SKILL_MARKET_PUBLIC_KEY（PEM），可配置多条（逗号/换行分隔）
 * - 安装时：先验签名，再逐文件校验 sha256，最后做路径穿越防护
 *
 * 环境变量：
 * - SKILL_MARKET_PUBLIC_KEY   Ed25519 公钥 PEM（必填才启用签名校验；未设置=跳过校验并告警）
 * - SKILL_MARKET_URL          市场 API 根地址，默认 https://agentskills.io
 * - SKILL_REQUIRE_SIGNATURE   =1 时未配置公钥则拒绝一切市场安装（fail-secure），默认 0
 */

import { createHash, createVerify, createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface MarketFileEntry {
  path: string;
  sha256: string;
}

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  files: MarketFileEntry[];
  signature: string; // base64 Ed25519 签名
}

export const DEFAULT_MARKET_URL = 'https://agentskills.io';

/** 规范化 manifest 用于签名（字段顺序固定，去掉 signature 本身） */
export function canonicalManifest(m: Omit<SkillManifest, 'signature'>): string {
  const obj = {
    name: m.name,
    version: m.version,
    files: m.files
      .map(f => ({ path: f.path, sha256: f.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  return JSON.stringify(obj);
}

/** sha256 hex */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Ed25519 验签；pubKeys 为 PEM 数组 */
export function verifyManifestSignature(manifest: SkillManifest, pubKeys: string[]): boolean {
  if (!manifest.signature) return false;
  const payload = canonicalManifest(manifest);
  const sig = Buffer.from(manifest.signature, 'base64');
  for (const pem of pubKeys) {
    try {
      const ok = createVerify('ed25519').update(payload).verify(pem, sig);
      if (ok) return true;
    } catch {
      // 单条公钥格式错误则跳过
    }
  }
  return false;
}

/** 从环境变量读取市场公钥列表 */
export function loadMarketPublicKeys(): string[] {
  const raw = process.env.SKILL_MARKET_PUBLIC_KEY || '';
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 路径穿越防护：只允许相对路径、禁止 .. 和绝对路径 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  const parts = p.split(/[\\/]/);
  return parts.every(part => part !== '..' && part !== '');
}

/** 校验文件内容与清单 sha256 一致；返回违规列表 */
export function verifyFilesAgainstManifest(
  files: Map<string, Buffer>,
  manifest: SkillManifest,
): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry.path)) {
      bad.push(`unsafe path: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    const buf = files.get(entry.path);
    if (!buf) {
      bad.push(`missing file: ${entry.path}`);
      continue;
    }
    if (sha256Hex(buf) !== entry.sha256.toLowerCase()) {
      bad.push(`sha256 mismatch: ${entry.path}`);
    }
  }
  // 包里多出清单以外的文件也算违规（防夹带）
  for (const p of files.keys()) {
    if (!seen.has(p)) bad.push(`unlisted file: ${p}`);
  }
  return bad;
}

/**
 * 完整校验一个市场技能包。
 * files: 包内文件 map（path -> 内容）
 * 返回 { ok, errors, manifest? }
 */
export function verifySkillPackage(
  files: Map<string, Buffer>,
  manifestRaw: string,
): { ok: boolean; errors: string[]; manifest?: SkillManifest } {
  const errors: string[] = [];
  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return { ok: false, errors: ['manifest.json 不是合法 JSON'] };
  }
  if (!manifest.name || !manifest.version || !Array.isArray(manifest.files)) {
    return { ok: false, errors: ['manifest.json 缺少 name/version/files 字段'] };
  }

  const pubKeys = loadMarketPublicKeys();
  const requireSig = process.env.SKILL_REQUIRE_SIGNATURE === '1';
  if (pubKeys.length === 0) {
    if (requireSig) {
      return { ok: false, errors: ['SKILL_REQUIRE_SIGNATURE=1 但未配置 SKILL_MARKET_PUBLIC_KEY，拒绝安装'] };
    }
    errors.push('WARN: 未配置 SKILL_MARKET_PUBLIC_KEY，跳过签名校验');
  } else if (!verifyManifestSignature(manifest, pubKeys)) {
    return { ok: false, errors: ['Ed25519 签名校验失败'] };
  }

  const fileErrors = verifyFilesAgainstManifest(files, manifest);
  errors.push(...fileErrors);

  // SKILL.md 必须存在且在清单内
  if (!files.has('SKILL.md')) errors.push('包内缺少 SKILL.md');

  return { ok: errors.length === 0 || (pubKeys.length === 0 && !requireSig && fileErrors.length === 0), errors, manifest };
}

/** 生成一对 Ed25519 密钥（用于市场侧签名，测试/自建市场用） */
export function generateSigningKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** 用私钥对 manifest 签名（市场侧/测试用） */
export function signManifest(manifest: Omit<SkillManifest, 'signature'>, privateKeyPem: string): string {
  return createSign('ed25519').update(canonicalManifest(manifest)).sign(privateKeyPem, 'base64');
}

/** 读取 PEM 文件内容（便于从文件加载公钥） */
export function readPemFile(path: string): string {
  return readFileSync(path, 'utf-8');
}
