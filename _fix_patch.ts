// P0 修复补丁：skill-sign.ts 加技能名校验 + loadMarketPublicKeys 清理脏逗号
import { readFileSync, writeFileSync } from 'fs';

const p = 'src/security/skill-sign.ts';
let s = readFileSync(p, 'utf-8');

// 1) 新增 isSafeSkillName 导出（放在 isSafeRelativePath 之后）
const anchor1 = `/** 校验文件内容与清单 sha256 一致；返回违规列表 */`;
const add1 = `/** 技能名校验：技能名将直接作为安装目录名，禁止路径分隔符、..、空白与控制字符 */
export function isSafeSkillName(name: unknown): boolean {
  return typeof name === 'string'
    && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.includes('..');
}

`;
if (!s.includes('isSafeSkillName')) {
  s = s.replace(anchor1, add1 + anchor1);
}

// 2) verifySkillPackage 里加 name 校验
const anchor2 = `  if (!manifest.name || !manifest.version || !Array.isArray(manifest.files)) {
    return { ok: false, errors: ['manifest.json 缺少 name/version/files 字段'] };
  }`;
const add2 = anchor2 + `

  // 技能名将直接作为安装目录名，必须严格校验（防路径穿越写任意目录 / name='..' 删除项目根）
  if (!isSafeSkillName(manifest.name)) {
    return { ok: false, errors: [\`非法技能名: \${JSON.stringify(manifest.name)}\`] };
  }`;
if (!s.includes('非法技能名')) {
  s = s.replace(anchor2, add2);
}

// 3) loadMarketPublicKeys：按 BEGIN 边界切分后清理块尾逗号/空白
const anchor3 = `  const blocks = raw.split(/(?=-----BEGIN PUBLIC KEY-----)/).map(s => s.trim()).filter(Boolean);`;
const add3 = `  const blocks = raw
    .split(/(?=-----BEGIN PUBLIC KEY-----)/)
    .map(s => s.trim().replace(/[,\\s]+$/, ''))
    .filter(Boolean);`;
if (s.includes(anchor3)) {
  s = s.replace(anchor3, add3);
}

writeFileSync(p, s, 'utf-8');
console.log('skill-sign.ts patched:', {
  hasNameCheck: s.includes('isSafeSkillName'),
  hasKeyCleanup: s.includes("replace(/[,\\\\s]+$/, '')"),
});

// 4) skill-market-secure.ts：install() 落盘前双保险校验
const p2 = 'src/skills/skill-market-secure.ts';
let s2 = readFileSync(p2, 'utf-8');
const anchor4 = `import {
  DEFAULT_MARKET_URL,
  verifySkillPackage,
  isSafeRelativePath,
  type SkillManifest,
} from '../security/skill-sign.js';`;
const add4 = `import {
  DEFAULT_MARKET_URL,
  verifySkillPackage,
  isSafeRelativePath,
  isSafeSkillName,
  type SkillManifest,
} from '../security/skill-sign.js';`;
if (s2.includes(anchor4)) s2 = s2.replace(anchor4, add4);

const anchor5 = `      const manifest: SkillManifest = verdict.manifest;
      const skillId = manifest.name;`;
const add5 = `      const manifest: SkillManifest = verdict.manifest;
      const skillId = manifest.name;
      // 双保险：落盘前再校验技能名（防路径穿越写任意目录）
      if (!isSafeSkillName(skillId)) {
        return { ok: false, errors: [\`非法技能名: \${skillId}\`] };
      }`;
if (s2.includes(anchor5) && !s2.includes('双保险')) s2 = s2.replace(anchor5, add5);

writeFileSync(p2, s2, 'utf-8');
console.log('skill-market-secure.ts patched:', {
  hasImport: s2.includes('isSafeSkillName'),
  hasGuard: s2.includes('双保险'),
});