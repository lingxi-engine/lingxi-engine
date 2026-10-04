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
    expect(isTrustedLocalSource(mkReq('47.93.157.83'))).toBe(false);
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
    expect(isTrustedLocalSource(mkReq('47.93.157.83'))).toBe(false);
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