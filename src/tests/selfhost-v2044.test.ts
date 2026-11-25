/**
 * v2.0.44 自部署模型测试
 * - 公开注册开关：默认开放；REGISTRATION_OPEN=false/0/off/closed/no 关闭（403 + registration_closed）
 * - hubUrl 不再默认连官方云端：无 env 无 link → 空（纯本地，不向外部登记/心跳）
 * - LINGXI_HUB_URL 指向用户自己的云端；=off 显式关闭；已保存的 link 保持兼容
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConnectService } from '../routes/app-connect.js';
import { registrationOpen, registrationClosedReply } from '../auth/registration-gate.js';

function makeService(): { svc: AppConnectService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lingxi-selfhost-'));
  const svc = new AppConnectService({
    dataDir: dir,
    port: 3456,
    version: '2.0.44-test',
    requireAuth: (_req: any, _res: any, next: any) => next(),
    db: { getUser: () => null },
    nextNumericId: () => 10001,
    directory: null,
  });
  return { svc, dir };
}

describe('v2.0.44 公开注册开关', () => {
  const OLD = process.env.REGISTRATION_OPEN;
  beforeEach(() => { delete process.env.REGISTRATION_OPEN; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.REGISTRATION_OPEN; else process.env.REGISTRATION_OPEN = OLD;
  });

  it('默认开放（自建实例各自注册各自的账号）', () => {
    expect(registrationOpen()).toBe(true);
    for (const v of ['true', '1', 'on', 'open', '']) {
      process.env.REGISTRATION_OPEN = v;
      expect(registrationOpen()).toBe(true);
    }
  });

  it('私有实例关闭：false/0/off/closed/no 均生效（大小写不敏感）', () => {
    for (const v of ['false', '0', 'off', 'closed', 'no', 'FALSE', 'Off']) {
      process.env.REGISTRATION_OPEN = v;
      expect(registrationOpen()).toBe(false);
    }
  });

  it('关闭时应答 403 + registration_closed + 双语引导', () => {
    let status = 0; let body: any = null;
    const res = {
      status(c: number) { status = c; return this; },
      json(b: any) { body = b; return this; },
    };
    registrationClosedReply(res);
    expect(status).toBe(403);
    expect(body.code).toBe('registration_closed');
    expect(String(body.error)).toContain('部署自己的灵犀引擎');
    expect(String(body.error)).toContain('deploy your own LingXi engine');
  });
});

describe('v2.0.44 hubUrl 去官方化（各自部署各自的服务器）', () => {
  let dir = '';
  const OLD_HUB = process.env.LINGXI_HUB_URL;
  const OLD_APPHUB = process.env.APP_HUB_URL;
  beforeEach(() => { delete process.env.LINGXI_HUB_URL; delete process.env.APP_HUB_URL; });
  afterEach(() => {
    if (OLD_HUB === undefined) delete process.env.LINGXI_HUB_URL; else process.env.LINGXI_HUB_URL = OLD_HUB;
    if (OLD_APPHUB === undefined) delete process.env.APP_HUB_URL; else process.env.APP_HUB_URL = OLD_APPHUB;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = ''; }
  });

  it('零配置默认空：不连接任何官方云端（纯本地模式）', () => {
    const { svc, dir: d } = makeService(); dir = d;
    expect(svc.hubUrl).toBe('');
  });

  it('LINGXI_HUB_URL 指向用户自己的云端（去尾部斜杠）', () => {
    process.env.LINGXI_HUB_URL = 'https://lingxi.my-domain.com/';
    const { svc, dir: d } = makeService(); dir = d;
    expect(svc.hubUrl).toBe('https://lingxi.my-domain.com');
  });

  it('LINGXI_HUB_URL=off 显式关闭', () => {
    process.env.LINGXI_HUB_URL = 'off';
    const { svc, dir: d } = makeService(); dir = d;
    expect(svc.hubUrl).toBe('');
  });

  it('已保存的 link 保持兼容（存量用户显式选择过的 hub 不被抹掉）', () => {
    const { svc, dir: d } = makeService(); dir = d;
    writeFileSync(join(d, 'app-link.json'), JSON.stringify({
      hubUrl: 'https://my-old-hub.example.com',
      instanceId: 'lingxi-app-test',
      secret: 's3cret',
      accounts: [{ email: 'a@b.c', userId: 'u1', accessToken: 't', refreshToken: 'r', linkedAt: Date.now() }],
      updatedAt: Date.now(),
    }));
    const svc2 = new AppConnectService({
      dataDir: d, port: 3456, version: '2.0.44-test',
      requireAuth: (_req: any, _res: any, next: any) => next(),
      db: { getUser: () => null }, nextNumericId: () => 10001, directory: null,
    });
    expect(svc2.hubUrl).toBe('https://my-old-hub.example.com');
  });

  it('env 优先于已保存 link（用户改指向自己的新云端）', () => {
    process.env.LINGXI_HUB_URL = 'https://new.my-domain.com';
    const { svc, dir: d } = makeService(); dir = d;
    writeFileSync(join(d, 'app-link.json'), JSON.stringify({
      hubUrl: 'https://old.example.com', instanceId: 'x', secret: 's', accounts: [], updatedAt: Date.now(),
    }));
    const svc2 = new AppConnectService({
      dataDir: d, port: 3456, version: '2.0.44-test',
      requireAuth: (_req: any, _res: any, next: any) => next(),
      db: { getUser: () => null }, nextNumericId: () => 10001, directory: null,
    });
    expect(svc2.hubUrl).toBe('https://new.my-domain.com');
  });
});