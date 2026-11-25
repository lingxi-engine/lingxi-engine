/**
 * v2.0.43 HUB_ONLY 纯连接 Hub 模式测试
 * - listFor 在 HUB_ONLY=1 时不展示 Hub 自身（它不提供 AI）
 * - 用户自己登记的桌面实例仍然正常展示
 * - HUB_ONLY 未设置 / =0 / =off 时行为与旧版一致（展示自身）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConnectService } from '../routes/app-connect.js';

function makeService(): { svc: AppConnectService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lingxi-hubonly-'));
  const svc = new AppConnectService({
    dataDir: dir,
    port: 3456,
    version: '2.0.43-test',
    requireAuth: (_req: any, _res: any, next: any) => next(),
    db: { getUser: () => null },
    nextNumericId: () => 10001,
    directory: null,
  });
  return { svc, dir };
}

const USER = { id: 'user-10000', numeric_id: 10000, email: 'tester@example.com' };

describe('HUB_ONLY listFor', () => {
  let dir = '';
  const OLD = process.env.HUB_ONLY;
  beforeEach(() => { delete process.env.HUB_ONLY; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.HUB_ONLY; else process.env.HUB_ONLY = OLD;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = ''; }
  });

  it('默认（未设置 HUB_ONLY）：列表包含 Hub 自身', () => {
    const { svc, dir: d } = makeService(); dir = d;
    const list = svc.listFor(USER);
    expect(list.some((x: any) => x.isThisDevice)).toBe(true);
  });

  it('HUB_ONLY=1：列表不含 Hub 自身，但保留用户登记的桌面实例', () => {
    process.env.HUB_ONLY = '1';
    const { svc, dir: d } = makeService(); dir = d;
    svc.register(USER, {
      instanceId: 'lingxi-app-testpc01',
      name: 'My PC',
      endpoint: 'http://192.168.1.5:3456',
      platform: 'Windows',
      version: '2.0.43',
      relayCapable: true,
    }, 'desktop');
    const list = svc.listFor(USER);
    expect(list.some((x: any) => x.isThisDevice)).toBe(false);
    const pc = list.find((x: any) => x.instanceId === 'lingxi-app-testpc01');
    expect(pc).toBeTruthy();
    expect(pc.endpoint).toBe('http://192.168.1.5:3456');
    expect(pc.online).toBe(true);
  });

  it('HUB_ONLY=true / on 同样生效；=0 / off 不生效', () => {
    for (const v of ['true', 'on', '1']) {
      process.env.HUB_ONLY = v;
      const { svc, dir: d } = makeService(); dir = d;
      expect(svc.listFor(USER).some((x: any) => x.isThisDevice)).toBe(false);
      rmSync(d, { recursive: true, force: true }); dir = '';
    }
    for (const v of ['0', 'off', 'false', '']) {
      process.env.HUB_ONLY = v;
      const { svc, dir: d } = makeService(); dir = d;
      expect(svc.listFor(USER).some((x: any) => x.isThisDevice)).toBe(true);
      rmSync(d, { recursive: true, force: true }); dir = '';
    }
  });
});
