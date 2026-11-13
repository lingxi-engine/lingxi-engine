/**
 * B8 回归测试：圆桌轮次配置化
 *
 * 锁死不变式：
 *   1. 默认轮次 3 不变（未设 ROUNDTABLE_MAX_ROUNDS）
 *   2. ROUNDTABLE_MAX_ROUNDS=5 → followUpContext.maxRounds=5，不再被静默截断为 3
 *   3. 绝对安全上限 12（防失控）；非法值回退默认 3
 *   4. dispatchRoundtableNext 在 round>=maxRounds 时自然总结收尾（needsFollowUp falsy）
 *   5. round<maxRounds 时继续下一轮且 maxRounds 透传
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let modes: any;
const ENV_KEY = 'ROUNDTABLE_MAX_ROUNDS';
let savedEnv: string | undefined;

const agents = [
  { id: 'a1', displayName: '甲', autonomy: 'full' },
  { id: 'a2', displayName: '乙', autonomy: 'full' },
];

beforeAll(async () => {
  savedEnv = process.env[ENV_KEY];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-test-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  modes = await import('../core/chat-modes.js');
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

async function dispatchRoundtable() {
  return await modes.dispatchByMode('c1', 'roundtable', 'u1', 'user', '议题X', agents, null, {});
}

describe('B8: 圆桌初始轮次可配置', () => {
  it('默认 3 轮（未设环境变量，行为不变）', async () => {
    delete process.env[ENV_KEY];
    const r = await dispatchRoundtable();
    expect(r.needsFollowUp).toBe(true);
    expect(r.followUpContext).toMatchObject({ type: 'roundtable', round: 1, maxRounds: 3 });
    expect(r.responses.length).toBe(2);
    expect(r.responses[0].customPrompt).toContain('共 3 轮');
  });

  it('ROUNDTABLE_MAX_ROUNDS=5 → maxRounds=5（修复前被截断为 3）', async () => {
    process.env[ENV_KEY] = '5';
    const r = await dispatchRoundtable();
    expect(r.followUpContext.maxRounds).toBe(5);
    expect(r.responses[0].customPrompt).toContain('共 5 轮');
  });

  it('超过绝对上限 12 → 钳制为 12（防失控）', async () => {
    process.env[ENV_KEY] = '99';
    const r = await dispatchRoundtable();
    expect(r.followUpContext.maxRounds).toBe(12);
  });

  it('非法值（0/负数/非数字）回退默认 3', async () => {
    for (const bad of ['0', '-2', 'abc', '']) {
      process.env[ENV_KEY] = bad;
      const r = await dispatchRoundtable();
      expect(r.followUpContext.maxRounds).toBe(3);
    }
  });

  it('小数向下取整', async () => {
    process.env[ENV_KEY] = '5.9';
    const r = await dispatchRoundtable();
    expect(r.followUpContext.maxRounds).toBe(5);
  });

  it('passive agent 不参与圆桌（既有行为不回归）', async () => {
    process.env[ENV_KEY] = '4';
    const withPassive = [...agents, { id: 'a3', displayName: '丙', autonomy: 'passive' }];
    const r = await modes.dispatchByMode('c1', 'roundtable', 'u1', 'user', '议题X', withPassive, null, {});
    expect(r.responses.length).toBe(2);
    expect(r.followUpContext.maxRounds).toBe(4);
  });
});

describe('B8: dispatchRoundtableNext 轮次推进与自然收尾', () => {
  it('round < maxRounds → 下一轮且 maxRounds 透传', () => {
    const r = modes.dispatchRoundtableNext('c1', agents, 4, 5);
    expect(r.needsFollowUp).toBe(true);
    expect(r.followUpContext).toMatchObject({ type: 'roundtable', round: 5, maxRounds: 5 });
    expect(r.responses.length).toBe(2);
    expect(r.responses[0].stage).toContain('第5轮');
  });

  it('round >= maxRounds → 总结收尾，不再继续', () => {
    const r = modes.dispatchRoundtableNext('c1', agents, 5, 5);
    expect(r.needsFollowUp).toBeFalsy();
    expect(r.followUpContext).toBeUndefined();
    expect(r.responses.length).toBe(1);
    expect(r.responses[0].stage).toBe('总结发言');
  });

  it('大轮次（12）同样自然收尾', () => {
    const mid = modes.dispatchRoundtableNext('c1', agents, 11, 12);
    expect(mid.followUpContext.round).toBe(12);
    const end = modes.dispatchRoundtableNext('c1', agents, 12, 12);
    expect(end.needsFollowUp).toBeFalsy();
  });

  it('无 agent 时总结返回 null（既有行为不回归）', () => {
    expect(modes.dispatchRoundtableNext('c1', [], 3, 3)).toBeNull();
  });
});
