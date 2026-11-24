/**
 * auth-trust.test.ts — isTrustedLocalSource trust-mode tests (v2.0.29)
 *
 * Covers the new TRUSTED_LOCAL_MODE switch:
 *   all (default) | loopback | none
 * plus XFF spoofing guard and ::ffff: normalisation.
 *
 * v2.0.32: the ALLOW_PUBLIC_ADMIN_AUTO escape hatch now requires dev mode,
 * so NODE_ENV=production must not grant public trust even when the flag is on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isTrustedLocalSource } from '../middleware/jwt-auth.js';
import { isDevMode, timingSafeTokenEqual } from '../security/token-compare.js';

function mkReq(ip: string, opts: { xff?: string; trustProxy?: boolean } = {}): any {
  return {
    socket: { remoteAddress: ip },
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    app: { get: () => !!opts.trustProxy },
  };
}

const savedNodeEnv = process.env.NODE_ENV;
const savedDevMode = process.env.DEV_MODE;

afterEach(() => {
  delete process.env.TRUSTED_LOCAL_MODE;
  delete process.env.ALLOW_PUBLIC_ADMIN_AUTO;
  delete process.env.NODE_ENV;
  delete process.env.DEV_MODE;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
  if (savedDevMode === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = savedDevMode;
});

describe('isTrustedLocalSource — default mode (all)', () => {
  it('trusts loopback', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1'))).toBe(true);
    expect(isTrustedLocalSource(mkReq('::1'))).toBe(true);
  });

  it('trusts RFC1918 private ranges', () => {
    expect(isTrustedLocalSource(mkReq('10.1.2.3'))).toBe(true);
    expect(isTrustedLocalSource(mkReq('192.168.1.5'))).toBe(true);
    expect(isTrustedLocalSource(mkReq('172.20.0.9'))).toBe(true);
  });

  it('normalises ::ffff: v4-mapped addresses', () => {
    expect(isTrustedLocalSource(mkReq('::ffff:10.0.0.7'))).toBe(true);
  });

  it('rejects public addresses', () => {
    expect(isTrustedLocalSource(mkReq('8.8.8.8'))).toBe(false);
    expect(isTrustedLocalSource(mkReq('203.0.113.7'))).toBe(false);
  });

  it('fails closed when source is unknown', () => {
    expect(isTrustedLocalSource(mkReq(''))).toBe(false);
    expect(isTrustedLocalSource({ socket: {}, headers: {}, app: { get: () => false } } as any)).toBe(false);
  });
});

describe('isTrustedLocalSource — TRUSTED_LOCAL_MODE=loopback', () => {
  it('trusts only loopback, rejects LAN', () => {
    process.env.TRUSTED_LOCAL_MODE = 'loopback';
    expect(isTrustedLocalSource(mkReq('127.0.0.1'))).toBe(true);
    expect(isTrustedLocalSource(mkReq('::1'))).toBe(true);
    expect(isTrustedLocalSource(mkReq('10.1.2.3'))).toBe(false);
    expect(isTrustedLocalSource(mkReq('192.168.1.5'))).toBe(false);
    expect(isTrustedLocalSource(mkReq('172.20.0.9'))).toBe(false);
  });
});

describe('isTrustedLocalSource — TRUSTED_LOCAL_MODE=none', () => {
  it('trusts nobody', () => {
    process.env.TRUSTED_LOCAL_MODE = 'none';
    expect(isTrustedLocalSource(mkReq('127.0.0.1'))).toBe(false);
    expect(isTrustedLocalSource(mkReq('10.1.2.3'))).toBe(false);
  });
});

describe('isTrustedLocalSource — escape hatch and XFF guard', () => {
  it('ALLOW_PUBLIC_ADMIN_AUTO=1 restores legacy public trust in dev mode', () => {
    process.env.ALLOW_PUBLIC_ADMIN_AUTO = '1';
    process.env.DEV_MODE = 'true';
    delete process.env.NODE_ENV;
    expect(isTrustedLocalSource(mkReq('8.8.8.8'))).toBe(true);
  });

  it('ALLOW_PUBLIC_ADMIN_AUTO is ignored when NODE_ENV=production', () => {
    process.env.ALLOW_PUBLIC_ADMIN_AUTO = '1';
    process.env.DEV_MODE = 'true'; // stale dev flag must not win
    process.env.NODE_ENV = 'production';
    expect(isTrustedLocalSource(mkReq('8.8.8.8'))).toBe(false);
    expect(isTrustedLocalSource(mkReq('203.0.113.7'))).toBe(false);
  });

  it('ALLOW_PUBLIC_ADMIN_AUTO is ignored when DEV_MODE=false', () => {
    process.env.ALLOW_PUBLIC_ADMIN_AUTO = '1';
    process.env.DEV_MODE = 'false';
    delete process.env.NODE_ENV;
    expect(isTrustedLocalSource(mkReq('8.8.8.8'))).toBe(false);
  });

  it('rejects XFF-spoofed public clients behind a trusted proxy', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('still trusts loopback without XFF', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { trustProxy: true }))).toBe(true);
  });
});

describe('isTrustedLocalSource — XFF 链伪造防护（P0 未授权访问回归）', () => {
  // 复现真实攻击：nginx 用 $proxy_add_x_forwarded_for，请求头 = 客户端自带 + ', ' + 真实地址。
  // 旧实现取链首（客户端可控），于是带 X-Forwarded-For: 127.0.0.1 即可拿到 admin。
  it('链首伪造 loopback、链尾是公网真实 IP → 拒绝', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '127.0.0.1, 8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('链首伪造内网 10.x、链尾是公网真实 IP → 拒绝', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '10.0.0.1, 203.0.113.7', trustProxy: true }))).toBe(false);
  });

  it('链首伪造 ::ffff: 形式 loopback → 仍拒绝', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '::ffff:127.0.0.1, 8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('多级伪造链，链尾为公网 → 拒绝', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '127.0.0.1, 10.1.1.1, 8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('链尾为 IPv4-mapped 公网地址 → 拒绝', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '127.0.0.1, ::ffff:8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('正常的本地请求（单跳，链尾即真实内网 IP）→ 放行', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '192.168.1.9', trustProxy: true }))).toBe(true);
  });

  it('带端口的内网链尾 → 放行', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '192.168.1.9:51234', trustProxy: true }))).toBe(true);
  });

  it('socket 本身是公网直连（无代理配置）→ 拒绝', () => {
    expect(isTrustedLocalSource(mkReq('8.8.8.8', { xff: '127.0.0.1', trustProxy: false }))).toBe(false);
  });

  it('TRUSTED_LOCAL_MODE=none 时即使链尾是 loopback 也拒绝', () => {
    process.env.TRUSTED_LOCAL_MODE = 'none';
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '127.0.0.1', trustProxy: true }))).toBe(false);
  });
});

describe('isDevMode', () => {
  it('treats NODE_ENV=production as non-dev regardless of DEV_MODE', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_MODE = 'true';
    expect(isDevMode()).toBe(false);
  });

  it('treats DEV_MODE=false as non-dev', () => {
    delete process.env.NODE_ENV;
    process.env.DEV_MODE = 'false';
    expect(isDevMode()).toBe(false);
  });

  it('defaults to dev when neither flag is set', () => {
    delete process.env.NODE_ENV;
    delete process.env.DEV_MODE;
    expect(isDevMode()).toBe(true);
  });
});

describe('timingSafeTokenEqual', () => {
  it('accepts identical tokens', () => {
    expect(timingSafeTokenEqual('secret-abc', 'secret-abc')).toBe(true);
  });

  it('rejects mismatches, differing lengths and missing values', () => {
    expect(timingSafeTokenEqual('secret-abd', 'secret-abc')).toBe(false);
    expect(timingSafeTokenEqual('short', 'much-longer-token')).toBe(false);
    expect(timingSafeTokenEqual(undefined, 'secret-abc')).toBe(false);
    expect(timingSafeTokenEqual('secret-abc', undefined)).toBe(false);
    expect(timingSafeTokenEqual('', '')).toBe(false);
  });
});