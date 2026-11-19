/**
 * S7 E2EE 跨实例回归测试（2026-11-19）
 *
 * 复现并验证修复：HKDF info 旧版拼 peerId（A 侧=对方实例 ID，B 侧=A 实例 ID），
 * 两侧派生不同根密钥/消息密钥 → AES-GCM 认证必失败 → 「[加密消息：解密失败]」。
 * 旧 e2ee-roundtrip.test.ts 只测 self-loop（加解密同 peerId），天然掩盖不对称缺陷。
 *
 * 本测试用两个独立临时库 + 两个独立 e2ee 模块实例（vi.resetModules 重置模块级
 * _identity/_sessions/_sendCounters 缓存），真实模拟两台引擎：
 *   交换公钥 → A 加密给 B → B 解密；反向亦然；连续消息计数器；身份密钥重启加载。
 *
 * better-sqlite3 直连 + sql.js 风格 facade 适配（e2ee.ts 只依赖 prepare/run/exec），
 * 不碰生产库、不依赖 db.ts 全局单例。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const INST_A = 'lingxi-lan-aaaaaaaaaaaa';
const INST_B = 'lingxi-lan-bbbbbbbbbbbb';

/** sql.js 风格 facade（e2ee.ts 的 db 参数契约：prepare→bind/step/getAsObject/free、run、exec） */
function makeDb(file: string) {
  const raw = new Database(file);
  raw.exec('CREATE TABLE IF NOT EXISTS e2ee_keys (id TEXT PRIMARY KEY, public_key TEXT, private_key TEXT, created_at INTEGER)');
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      let bound: any[] = [];
      let rows: any[] | null = null;
      let idx = 0;
      return {
        bind(params: any[]) { bound = params; rows = null; idx = 0; },
        step() {
          if (rows === null) rows = stmt.all(...bound) as any[];
          if (idx < rows.length) { idx++; return true; }
          return false;
        },
        getAsObject() { return rows![idx - 1]; },
        free() { /* better-sqlite3 语句无需手动释放 */ },
      };
    },
    run(sql: string, params: any[] = []) { raw.prepare(sql).run(...params); },
    exec(sql: string) {
      const rows = raw.prepare(sql).all() as any[];
      return [{ values: rows.map(r => Object.values(r)) }];
    },
    close() { raw.close(); },
  };
}

/** 取一个全新的 e2ee 模块实例（重置模块级身份/会话/计数器缓存） */
async function freshE2ee() {
  const { vi } = await import('vitest');
  vi.resetModules();
  return await import('../security/e2ee.js');
}

let dir: string;
let dbA: ReturnType<typeof makeDb>;
let dbB: ReturnType<typeof makeDb>;
let e2eeA: Awaited<ReturnType<typeof freshE2ee>>;
let e2eeB: Awaited<ReturnType<typeof freshE2ee>>;
let pubA: string;
let pubB: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lingxi-e2ee-x-'));
  dbA = makeDb(join(dir, 'a.db'));
  e2eeA = await freshE2ee();
  pubA = e2eeA.getIdentityPublicKeyB64(dbA);

  dbB = makeDb(join(dir, 'b.db'));
  e2eeB = await freshE2ee();
  pubB = e2eeB.getIdentityPublicKeyB64(dbB);

  // 模拟 /api/lan/peer/key-exchange 双向交换
  e2eeA.setPeerPublicKey(dbA, INST_B, pubB);
  e2eeB.setPeerPublicKey(dbB, INST_A, pubA);
});

afterAll(() => {
  try { dbA?.close(); } catch { /* ignore */ }
  try { dbB?.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('S7 E2EE 跨实例对称派生（双引擎真实场景）', () => {
  it('两实例身份密钥互异且各自持久化', () => {
    expect(pubA).toBeTruthy();
    expect(pubB).toBeTruthy();
    expect(pubA).not.toBe(pubB);
    expect(e2eeA.getPeerPublicKey(dbA, INST_B)).toBe(pubB);
    expect(e2eeB.getPeerPublicKey(dbB, INST_A)).toBe(pubA);
  });

  it('A 加密 → B 解密还原明文（核心回归：旧代码此处必失败）', () => {
    const plain = '你好，跨引擎的朋友！';
    const ct = e2eeA.encryptForPeer(dbA, INST_B, plain);
    expect(ct).toBeTruthy();
    expect(e2eeA.isE2EE(ct!)).toBe(true);
    expect(ct).not.toContain(plain);
    expect(e2eeB.decryptFromPeer(dbB, INST_A, ct!)).toBe(plain);
  });

  it('B 加密 → A 解密还原明文（反向通道）', () => {
    const plain = '收到！双向通道正常。';
    const ct = e2eeB.encryptForPeer(dbB, INST_A, plain);
    expect(ct).toBeTruthy();
    expect(e2eeA.decryptFromPeer(dbA, INST_B, ct!)).toBe(plain);
  });

  it('连续 5 条消息计数器严格递增且全部可解', () => {
    // 计数器按 peerId 跨用例累计，断言相对递增而非绝对值
    let prev = -1;
    for (let i = 1; i <= 5; i++) {
      const plain = `第 ${i} 条消息 🔒`;
      const ct = e2eeA.encryptForPeer(dbA, INST_B, plain);
      expect(ct).toBeTruthy();
      const counter = Number(ct!.split(':').pop());
      expect(Number.isFinite(counter)).toBe(true);
      if (prev >= 0) expect(counter).toBe(prev + 1); // 计数器随密文传输且每条 +1
      prev = counter;
      expect(e2eeB.decryptFromPeer(dbB, INST_A, ct!)).toBe(plain);
    }
  });

  it('双向交错发送（各自独立计数器）互不串扰', () => {
    const a1 = e2eeA.encryptForPeer(dbA, INST_B, 'A→B 交错 1')!;
    const b1 = e2eeB.encryptForPeer(dbB, INST_A, 'B→A 交错 1')!;
    const a2 = e2eeA.encryptForPeer(dbA, INST_B, 'A→B 交错 2')!;
    expect(e2eeB.decryptFromPeer(dbB, INST_A, a1)).toBe('A→B 交错 1');
    expect(e2eeA.decryptFromPeer(dbA, INST_B, b1)).toBe('B→A 交错 1');
    expect(e2eeB.decryptFromPeer(dbB, INST_A, a2)).toBe('A→B 交错 2');
  });

  it('身份密钥重启加载：新模块实例从库中恢复同一身份并继续解密', async () => {
    const e2eeA2 = await freshE2ee(); // 模拟 A 引擎重启（模块缓存清空）
    expect(e2eeA2.getIdentityPublicKeyB64(dbA)).toBe(pubA);
    const ct = e2eeB.encryptForPeer(dbB, INST_A, '重启后仍能解密');
    expect(e2eeA2.decryptFromPeer(dbA, INST_B, ct!)).toBe('重启后仍能解密');
  });

  it('未知 peer 公钥 → 加密返回 null（降级明文契约不变）', () => {
    expect(e2eeA.encryptForPeer(dbA, 'lingxi-lan-unknown', 'hi')).toBeNull();
  });

  it('非 e2ee 前缀原样返回（历史明文兼容契约不变）', () => {
    expect(e2eeB.decryptFromPeer(dbB, INST_A, '普通明文消息')).toBe('普通明文消息');
  });

  it('篡改密文 → 解密失败返回占位符（GCM 认证仍有效）', () => {
    const ct = e2eeA.encryptForPeer(dbA, INST_B, '不可篡改')!;
    const parts = ct.split(':');
    // 翻转密文段一个字符
    const data = parts[4];
    parts[4] = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    const tampered = parts.join(':');
    expect(e2eeB.decryptFromPeer(dbB, INST_A, tampered)).toBe('[加密消息：解密失败]');
  });
});
