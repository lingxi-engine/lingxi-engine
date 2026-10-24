/**
 * 手机 App 连接层回归测试
 * ================================================================
 * 覆盖此前导致「手机 App 连不上这台电脑」的全部根因：
 *
 *  P0-1  instanceId 冲突：云端 Hub 与用户电脑拿到同一个 instanceId
 *         → 电脑 register 覆盖云端记录 → 手机接管永远跳回云端
 *  P0-2  endpoint 覆盖：云端 selfRecord() 把电脑的 endpoint 抢回云端自己
 *  P0-3  规模化：JSON 全量读写 → 必须换成 SQLite（AppDirectoryStore）
 *  P0-4  心跳鉴权：实例密钥必须真的校验，不能随便一个 secret 就过
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AppConnectService } from '../routes/app-connect.js';
import { AppDirectoryStore } from '../storage/app-directory.js';

/**
 * 用【真实 sql.js】建库。
 * 之前用假 DB（正则解析 SQL）导致测试在测「正则写对没有」而不是「产品逻辑对不对」，
 * 一旦 app-directory.ts 的 SQL 换行/字段顺序调整，假 DB 就静默失效 —— 比没有测试更危险。
 */
async function makeDb(): Promise<any> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  return new SQL.Database();
}

function makeDeps(dataDir: string, db: any, over: any = {}) {
  return {
    dataDir,
    port: 3456,
    version: '2.0.38',
    requireAuth: (_req: any, _res: any, next: any) => next(),
    db,
    nextNumericId: () => 10001,
    ...over,
  };
}

const fakeUser = { sub: 'user-10000', numeric_id: 10000, email: 'a@163.com' };

describe('AppConnect · instanceId 冲突（连不上电脑的直接原因）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingxi-app-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('云端与电脑的 instanceId 必须不同（不能复用 lan-identity.json）', async () => {
    // 模拟旧部署：data/ 目录被整体复制到云端，连同 lan-identity.json
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lan-identity.json'), JSON.stringify({ instanceId: 'lingxi-lan-e4707cb5-b2f' }));
    // 云端与电脑是【两台不同机器】，各自有自己的 data/ 目录
    const pcDir = mkdtempSync(join(tmpdir(), 'lingxi-app-pc-'));

    const db = await makeDb();
    const cloud = new AppConnectService(makeDeps(dir, db));
    const pc = new AppConnectService(makeDeps(pcDir, db));
    try { rmSync(pcDir, { recursive: true, force: true }); } catch { /* ignore */ }

    expect(cloud.instanceId).not.toBe(pc.instanceId);
    expect(cloud.instanceId).toMatch(/^lingxi-app-/);
    expect(pc.instanceId).toMatch(/^lingxi-app-/);
    // 绝不能是旧的 lan- 前缀
    expect(cloud.instanceId).not.toBe('lingxi-lan-e4707cb5-b2f');
  });

  it('instanceId 必须持久化到 app-identity.json（重启不变）', async () => {
    const db = await makeDb();
    const a = new AppConnectService(makeDeps(dir, db));
    const idFile = join(dir, 'app-identity.json');
    expect(existsSync(idFile)).toBe(true);
    const saved = JSON.parse(readFileSync(idFile, 'utf8'));
    expect(saved.instanceId).toBe(a.instanceId);

    const b = new AppConnectService(makeDeps(dir, db));
    expect(b.instanceId).toBe(a.instanceId);
  });

  it('电脑登记到云端后，云端不得把电脑的 endpoint 抢回云端自己', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    const pcDir = mkdtempSync(join(tmpdir(), 'lingxi-app-pc-'));
    const cloud = new AppConnectService(makeDeps(dir, db, { directory, getLanIp: () => '10.0.0.1' }));
    const pc = new AppConnectService(makeDeps(pcDir, db, { directory, getLanIp: () => '192.168.1.6' }));

    // 电脑登记（模拟 linkAccount 里的 register 调用）
    const reg = cloud.register(fakeUser, {
      instanceId: pc.instanceId,
      name: 'DESKTOP-AHH3286',
      endpoint: 'http://192.168.1.6:3456',
      platform: 'Windows',
      version: '2.0.38',
      agentCount: 57,
    }, 'desktop');

    expect(reg.ok).toBe(true);
    expect(reg.instanceId).toBe(pc.instanceId);

    // 云端自己的记录必须仍是云端 endpoint（绝不能被电脑的 endpoint 覆盖）
    const self = cloud.getInstance(cloud.instanceId);
    expect(self).toBeTruthy();
    expect(self!.endpoint).toBe('http://10.0.0.1:3456');
    expect(self!.endpoint).not.toBe('http://192.168.1.6:3456');

    // 电脑的记录必须保留电脑 endpoint
    const pcRec = cloud.getInstance(pc.instanceId);
    expect(pcRec).toBeTruthy();
    expect(pcRec!.endpoint).toBe('http://192.168.1.6:3456');
    expect(pcRec!.platform).toBe('Windows');
  });

  it('手机列表里必须同时出现云端和电脑，且 endpoint 各自正确', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    const pcDir = mkdtempSync(join(tmpdir(), 'lingxi-app-pc-'));
    const cloud = new AppConnectService(makeDeps(dir, db, { directory, getLanIp: () => '10.0.0.1' }));
    const pc = new AppConnectService(makeDeps(pcDir, db, { directory, getLanIp: () => '192.168.1.6' }));

    cloud.register(fakeUser, {
      instanceId: pc.instanceId,
      name: 'DESKTOP-AHH3286',
      endpoint: 'http://192.168.1.6:3456',
      platform: 'Windows',
    }, 'desktop');

    const list = cloud.listFor(fakeUser);
    const ids = list.map((x: any) => x.instanceId);
    expect(ids).toContain(cloud.instanceId);
    expect(ids).toContain(pc.instanceId);

    const pcItem = list.find((x: any) => x.instanceId === pc.instanceId)!;
    expect(pcItem.endpoint).toBe('http://192.168.1.6:3456');
    expect(pcItem.kind).toBe('desktop');
    expect(pcItem.isThisDevice).toBe(false);
  });
});

describe('AppConnect · 票据与心跳鉴权', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingxi-app-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('心跳必须校验实例密钥（错误密钥不得通过）', async () => {
    const db = await makeDb();
    const svc = new AppConnectService(makeDeps(dir, db));
    const reg = svc.register(fakeUser, { instanceId: 'pc-1', endpoint: 'http://192.168.1.6:3456' }, 'desktop');

    expect(svc.heartbeat('pc-1', reg.secret, { agentCount: 3 })).toBe(true);
    expect(svc.heartbeat('pc-1', 'wrong-secret', { agentCount: 3 })).toBe(false);
    expect(svc.heartbeat('nonexistent', reg.secret, {})).toBe(false);
  });

  it('票据一次性：兑换后立即失效', async () => {
    const db = await makeDb();
    const svc = new AppConnectService(makeDeps(dir, db));
    const reg = svc.register(fakeUser, { instanceId: 'pc-1', endpoint: 'http://192.168.1.6:3456' }, 'desktop');
    const t = svc.issueTicket(fakeUser, 'pc-1');

    expect(svc.verifyTicket('pc-1', reg.secret, t.ticket)).toBeTruthy();
    // 第二次必须失败
    expect(svc.verifyTicket('pc-1', reg.secret, t.ticket)).toBeNull();
  });

  it('票据不能跨实例使用（防止拿 A 的票据接管 B）', async () => {
    const db = await makeDb();
    const svc = new AppConnectService(makeDeps(dir, db));
    const regA = svc.register(fakeUser, { instanceId: 'pc-A', endpoint: 'http://a:3456' }, 'desktop');
    const regB = svc.register(fakeUser, { instanceId: 'pc-B', endpoint: 'http://b:3456' }, 'desktop');
    const t = svc.issueTicket(fakeUser, 'pc-A');

    expect(svc.verifyTicket('pc-B', regB.secret, t.ticket)).toBeNull();
    expect(svc.verifyTicket('pc-A', regA.secret, t.ticket)).toBeTruthy();
  });

  it('错误实例密钥不得兑换票据', async () => {
    const db = await makeDb();
    const svc = new AppConnectService(makeDeps(dir, db));
    svc.register(fakeUser, { instanceId: 'pc-1', endpoint: 'http://a:3456' }, 'desktop');
    const t = svc.issueTicket(fakeUser, 'pc-1');
    expect(svc.verifyTicket('pc-1', 'bogus', t.ticket)).toBeNull();
  });
});

describe('AppConnect · 规模化（几千到几万用户）', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lingxi-app-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('SQLite 目录：1000 台设备登记 + 按 owner 查询应正常', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    const svc = new AppConnectService(makeDeps(dir, db, { directory }));

    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      svc.register({ sub: 'u' + i, numeric_id: i, email: `u${i}@x.com` }, {
        instanceId: 'pc-' + i,
        endpoint: `http://192.168.1.${i % 250}:3456`,
        platform: 'Windows',
      }, 'desktop');
    }
    const elapsed = Date.now() - t0;

    // 构造函数会先建 1 条自身记录，所以总数是 1001
    expect(directory.count()).toBe(1001);
    // 1000 次登记必须在 5 秒内完成（JSON 全量重写会超时）
    expect(elapsed).toBeLessThan(5000);

    // 按 owner 查询只返回自己的设备
    const mine = svc.listFor({ sub: 'u42', numeric_id: 42, email: 'u42@x.com' });
    const ids = mine.map((x: any) => x.instanceId);
    expect(ids).toContain('pc-42');
    expect(ids).not.toContain('pc-43');
  });

  it('心跳只更新一行，不触发全量重写', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    const svc = new AppConnectService(makeDeps(dir, db, { directory }));
    const reg = svc.register(fakeUser, { instanceId: 'pc-1', endpoint: 'http://a:3456' }, 'desktop');

    const before = directory.count();
    for (let i = 0; i < 100; i++) {
      expect(svc.heartbeat('pc-1', reg.secret, { agentCount: i })).toBe(true);
    }
    expect(directory.count()).toBe(before);
    expect(directory.get('pc-1')!.agentCount).toBe(99);
  });

  it('prune 清理长期不活跃设备（防止目录无限膨胀）', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    const svc = new AppConnectService(makeDeps(dir, db, { directory }));
    svc.register(fakeUser, { instanceId: 'old-1', endpoint: 'http://a:3456' }, 'desktop');

    // 把 last_seen 改成很久以前
    const rec = directory.get('old-1')!;
    rec.lastSeen = Date.now() - 30 * 24 * 3600_000;
    directory.upsert(rec);

    expect(directory.count()).toBe(2); // 自身记录 + old-1
    directory.prune();
    // 过期设备被清掉，自身记录因 lastSeen 是「刚刚」而保留
    expect(directory.count()).toBe(1);
    expect(directory.get('old-1')).toBeNull();
    expect(directory.get(svc.instanceId)).toBeTruthy();
  });

  it('旧 JSON 目录可一次性迁移到 SQLite（幂等）', async () => {
    const db = await makeDb();
    const directory = new AppDirectoryStore(db as any);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app-instances.json'), JSON.stringify({
      instances: [
        { instanceId: 'legacy-1', ownerKey: 'a@x.com', name: 'Old', endpoint: 'http://old:3456', lastSeen: Date.now() },
      ],
    }));

    const svc = new AppConnectService(makeDeps(dir, db, { directory }));
    expect(directory.count()).toBe(2); // 自身记录 + legacy-1
    expect(directory.get('legacy-1')).toBeTruthy();

    // 再建一次不应重复迁移
    const svc2 = new AppConnectService(makeDeps(dir, db, { directory }));
    expect(directory.count()).toBe(2);
    expect(svc2.instanceId).toBe(svc.instanceId);
  });
});

describe('AppConnect · 内存兜底（无 SQLite 时）', () => {
  it('没有 directory 时仍能正常工作', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-app-'));
    try {
      const db = await makeDb();
      const svc = new AppConnectService(makeDeps(dir, db, { directory: null }));
      const reg = svc.register(fakeUser, { instanceId: 'pc-1', endpoint: 'http://a:3456' }, 'desktop');
      expect(reg.ok).toBe(true);
      expect(svc.heartbeat('pc-1', reg.secret, {})).toBe(true);
      expect(svc.listFor(fakeUser).some((x: any) => x.instanceId === 'pc-1')).toBe(true);
      expect(svc.status().storage).toBe('memory');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
