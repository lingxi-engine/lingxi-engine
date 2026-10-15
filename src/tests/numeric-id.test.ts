/**
 * numeric_id 号段分配 — 回归测试（2026-10-15）
 *
 * 锁死这个曾经致命的 bug：
 *   `nextNumericId()` 旧实现只做内存自增 `_nextNumericId++`，而引擎里存在
 *   「不走分配器、直接写库」的号段消费者 —— 典型是 index.ts `ensureUserSetup()`
 *   给**访客连 WebSocket 时**补号（`SELECT MAX(numeric_id)+1` 直写）。
 *   前端一打开聊天页就连 WS，所以任何人访问一次官网就占掉一个号，
 *   而内存计数器仍停在同一个值 → 下一个真实注册必然
 *   `UNIQUE constraint failed: users.numeric_id`（新用户 100% 注册失败）。
 *
 * 不变式：nextNumericId() 返回的值必须严格大于库内 MAX(numeric_id)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let db: any;

/** 库内当前最大 numeric_id（无人时按 9999 兜底，与 initNumericIdSeq 一致） */
function dbMaxNumericId(): number {
  const raw = db.getDB();
  const s = raw.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL');
  s.step();
  const max = s.getAsObject().m ?? 9999;
  s.free();
  return max;
}

/** 模拟 index.ts ensureUserSetup()：访客补号，直写 MAX+1，不推进内存计数器 */
function simulateGuestClaim() {
  const raw = db.getDB();
  const nid = dbMaxNumericId() + 1;
  raw.run(
    'INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?, ?, ?, ?)',
    [`guest-ws-${nid}`, `用户${nid}`, Date.now(), nid]
  );
  return nid;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-id-test-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  db = await import('../storage/db.js');
  await db.initDB(path.join(tmpDir, 'test.db'));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('nextNumericId — 号段分配与库内 MAX 保持一致', () => {
  it('分配器从 10000 起且严格大于库内 MAX', () => {
    const a = db.nextNumericId();
    expect(a).toBeGreaterThan(9999);
    expect(a).toBeGreaterThan(dbMaxNumericId());
  });

  it('访客直写 MAX+1 后，下一次分配不得撞号（旧实现在此必崩）', () => {
    // 1) 正常注册一次：号被真实占用，内存计数器随之 +1
    const reg = db.nextNumericId();
    db.createFullUser({
      id: String(reg), numericId: reg, email: `reg${reg}@t.com`,
      passwordHash: 'x', displayName: `注册${reg}`,
    });
    expect(dbMaxNumericId()).toBe(reg);

    // 2) 访客连 WS：直写 MAX+1，绕过分配器（旧实现的致命裂隙）
    const guest = simulateGuestClaim();
    expect(guest).toBe(reg + 1);

    // 3) 再注册。旧实现返回 reg+1（已被访客占用）→ assert 失败 / INSERT 抛 UNIQUE
    const next = db.nextNumericId();
    expect(next).toBeGreaterThan(dbMaxNumericId());

    expect(() => db.createFullUser({
      id: String(next), numericId: next, email: `next${next}@t.com`,
      passwordHash: 'x', displayName: `注册${next}`,
    })).not.toThrow();
  });

  it('连续「注册 → 访客占号」多轮不撞号', () => {
    for (let i = 0; i < 5; i++) {
      const reg = db.nextNumericId();
      expect(() => db.createFullUser({
        id: String(reg), numericId: reg, email: `loop${i}@t.com`,
        passwordHash: 'x', displayName: `循环${i}`,
      })).not.toThrow();
      simulateGuestClaim();
      expect(db.nextNumericId()).toBeGreaterThan(dbMaxNumericId());
    }
  });
});
