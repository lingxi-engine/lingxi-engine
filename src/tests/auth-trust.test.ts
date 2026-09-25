/**
 * auth-trust.test.ts — isTrustedLocalSource trust-mode tests (v2.0.29)
 *
 * Covers the new TRUSTED_LOCAL_MODE switch:
 *   all (default) | loopback | none
 * plus XFF spoofing guard and ::ffff: normalisation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isTrustedLocalSource } from '../middleware/jwt-auth.js';

function mkReq(ip: string, opts: { xff?: string; trustProxy?: boolean } = {}): any {
  return {
    socket: { remoteAddress: ip },
    headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
    app: { get: () => !!opts.trustProxy },
  };
}

afterEach(() => {
  delete process.env.TRUSTED_LOCAL_MODE;
  delete process.env.ALLOW_PUBLIC_ADMIN_AUTO;
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
  it('ALLOW_PUBLIC_ADMIN_AUTO=1 restores legacy public trust', () => {
    process.env.ALLOW_PUBLIC_ADMIN_AUTO = '1';
    expect(isTrustedLocalSource(mkReq('8.8.8.8'))).toBe(true);
  });

  it('rejects XFF-spoofed public clients behind a trusted proxy', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { xff: '8.8.8.8', trustProxy: true }))).toBe(false);
  });

  it('still trusts loopback without XFF', () => {
    expect(isTrustedLocalSource(mkReq('127.0.0.1', { trustProxy: true }))).toBe(true);
  });
});
