/**
 * 技能市场签名校验单元测试
 * 覆盖：canonical 稳定性、Ed25519 签名验签、sha256 文件校验、
 *       路径穿越防护、未列文件夹带、fail-secure 开关
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canonicalManifest,
  sha256Hex,
  verifyManifestSignature,
  verifyFilesAgainstManifest,
  verifySkillPackage,
  isSafeRelativePath,
  generateSigningKeyPair,
  signManifest,
  type SkillManifest,
} from '../security/skill-sign.js';

const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();

function makeManifest(files: { path: string; sha256: string }[]): Omit<SkillManifest, 'signature'> {
  return { name: 'demo-skill', version: '1.0.0', files };
}

function signedManifest(files: { path: string; sha256: string }[]): SkillManifest {
  const base = makeManifest(files);
  return { ...base, signature: signManifest(base, privateKeyPem) };
}

describe('skill-sign: 路径安全', () => {
  it('拒绝绝对路径和 .. 穿越', () => {
    expect(isSafeRelativePath('SKILL.md')).toBe(true);
    expect(isSafeRelativePath('docs/readme.md')).toBe(true);
    expect(isSafeRelativePath('../evil.md')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('C:\\evil.md')).toBe(false);
    expect(isSafeRelativePath('a/../../b')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });
});

describe('skill-sign: 签名', () => {
  it('canonical 不受 files 顺序影响', () => {
    const a = canonicalManifest(makeManifest([
      { path: 'a.md', sha256: 'aa' },
      { path: 'b.md', sha256: 'bb' },
    ]));
    const b = canonicalManifest(makeManifest([
      { path: 'b.md', sha256: 'bb' },
      { path: 'a.md', sha256: 'aa' },
    ]));
    expect(a).toBe(b);
  });

  it('正确签名可通过验签，篡改后失败', () => {
    const m = signedManifest([{ path: 'SKILL.md', sha256: sha256Hex('hello') }]);
    expect(verifyManifestSignature(m, [publicKeyPem])).toBe(true);
    const tampered: SkillManifest = { ...m, version: '9.9.9', signature: m.signature };
    expect(verifyManifestSignature(tampered, [publicKeyPem])).toBe(false);
    // 错误公钥也失败
    const other = generateSigningKeyPair();
    expect(verifyManifestSignature(m, [other.publicKeyPem])).toBe(false);
  });
});

describe('skill-sign: 文件校验', () => {
  it('sha256 匹配通过，不匹配/缺失/多文件都报错', () => {
    const content = Buffer.from('hello world');
    const manifest = signedManifest([{ path: 'SKILL.md', sha256: sha256Hex(content) }]);
    const files = new Map([['SKILL.md', content]]);
    expect(verifyFilesAgainstManifest(files, manifest)).toEqual([]);

    // 篡改内容
    const bad = new Map([['SKILL.md', Buffer.from('tampered')]]);
    expect(verifyFilesAgainstManifest(bad, manifest).some(e => e.includes('sha256 mismatch'))).toBe(true);

    // 缺文件
    expect(verifyFilesAgainstManifest(new Map(), manifest).some(e => e.includes('missing file'))).toBe(true);

    // 夹带未列文件
    const extra = new Map([['SKILL.md', content], ['evil.sh', Buffer.from('rm -rf')]]);
    expect(verifyFilesAgainstManifest(extra, manifest).some(e => e.includes('unlisted file'))).toBe(true);
  });
});

describe('skill-sign: 完整包校验 + 环境开关', () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.SKILL_MARKET_PUBLIC_KEY;
    delete process.env.SKILL_REQUIRE_SIGNATURE;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('配置公钥后：合法包通过，未签名包拒绝', () => {
    process.env.SKILL_MARKET_PUBLIC_KEY = publicKeyPem;
    const content = Buffer.from('# Demo\n');
    const manifest = signedManifest([{ path: 'SKILL.md', sha256: sha256Hex(content) }]);
    const files = new Map([['SKILL.md', content]]);
    const ok = verifySkillPackage(files, JSON.stringify(manifest));
    expect(ok.ok).toBe(true);

    const unsigned: SkillManifest = { ...manifest, signature: '' };
    const bad = verifySkillPackage(files, JSON.stringify(unsigned));
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toContain('签名');
  });

  it('SKILL_REQUIRE_SIGNATURE=1 且无公钥时 fail-secure 拒绝', () => {
    process.env.SKILL_REQUIRE_SIGNATURE = '1';
    const content = Buffer.from('x');
    const manifest = signedManifest([{ path: 'SKILL.md', sha256: sha256Hex(content) }]);
    const files = new Map([['SKILL.md', content]]);
    const r = verifySkillPackage(files, JSON.stringify(manifest));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('SKILL_MARKET_PUBLIC_KEY');
  });

  it('未配置公钥且未开 fail-secure：仅告警，文件校验仍生效', () => {
    const content = Buffer.from('x');
    const manifest = signedManifest([{ path: 'SKILL.md', sha256: sha256Hex(content) }]);
    const files = new Map([['SKILL.md', content]]);
    const r = verifySkillPackage(files, JSON.stringify(manifest));
    expect(r.ok).toBe(true); // 警告不阻断
    expect(r.errors.some(e => e.startsWith('WARN'))).toBe(true);
  });

  it('manifest 非法 JSON 直接拒绝', () => {
    const r = verifySkillPackage(new Map(), 'not-json');
    expect(r.ok).toBe(false);
  });
});
