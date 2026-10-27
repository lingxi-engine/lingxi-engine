import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticDedup } from '../semantic-dedup.js';
import { detectConflicts } from '../fact-conflict-detector.js';

/**
 * 多用户隔离回归测试
 *
 * 背景：旧实现把 fact 的裸 key（如 "city"）直接塞进全局 LSH 索引，
 * 于是 A 用户的 "city=上海" 会让 B 用户的 "city=上海" 被判为语义重复而直接丢弃。
 * 在几千用户规模下，这会让大量用户的记忆凭空消失，且没有任何报错。
 *
 * 这些用例把「不同 scope 互不影响」钉死，防止将来被改回去。
 */
describe('多用户记忆隔离', () => {
  let dedup: SemanticDedup;

  beforeEach(() => {
    dedup = new SemanticDedup(0.78);
  });

  it('不同 scope 的相同内容不应互相判重', async () => {
    const value = '用户在上海做外贸';

    // 用户 A 先写入
    const dupA = await dedup.checkAndAdd('city', value, 'agent:user-a');
    expect(dupA).toBe(false);

    // 用户 B 写入完全相同的内容 —— 必须被接受，不能被丢弃
    const dupB = await dedup.checkAndAdd('city', value, 'agent:user-b');
    expect(dupB).toBe(false);

    // 用户 C 同样
    const dupC = await dedup.checkAndAdd('city', value, 'agent:user-c');
    expect(dupC).toBe(false);
  });

  it('同一 scope 内的重复内容仍应被识别', async () => {
    const value = '用户偏好用中文交流';

    expect(await dedup.checkAndAdd('lang', value, 'agent:user-a')).toBe(false);
    // 同一用户、同一 scope、再写一遍 → 应判为重复
    expect(await dedup.checkAndAdd('lang', value, 'agent:user-a')).toBe(true);
  });

  it('不同 chat 的相同内容不应互相判重', async () => {
    const value = '这个项目预算是一百万';

    expect(await dedup.checkAndAdd('budget', value, 'chat:c1:agent-a')).toBe(false);
    expect(await dedup.checkAndAdd('budget', value, 'chat:c2:agent-a')).toBe(false);
    expect(await dedup.checkAndAdd('budget', value, 'chat:c1:agent-a')).toBe(true);
  });

  it('remove 只影响指定 scope', async () => {
    const value = '用户喜欢深色模式';

    await dedup.checkAndAdd('theme', value, 'agent:user-a');
    await dedup.checkAndAdd('theme', value, 'agent:user-b');

    // 移除 A 的
    dedup.remove('theme', 'agent:user-a');

    // A 的可以重新写入
    expect(await dedup.checkAndAdd('theme', value, 'agent:user-a')).toBe(false);
    // B 的仍然在，仍然判重
    expect(await dedup.checkAndAdd('theme', value, 'agent:user-b')).toBe(true);
  });

  it('rebuild 按 scope 分组，不互相覆盖', async () => {
    dedup.rebuild([
      { key: 'city', value: '用户在上海做外贸', scope: 'agent:user-a' },
      { key: 'city', value: '用户在北京做金融', scope: 'agent:user-b' },
    ]);

    // A 自己的内容已存在 → 判重
    expect(await dedup.checkAndAdd('city', '用户在上海做外贸', 'agent:user-a')).toBe(true);
    // B 自己的内容已存在 → 判重
    expect(await dedup.checkAndAdd('city', '用户在北京做金融', 'agent:user-b')).toBe(true);
    // C 的全新内容 → 不判重
    expect(await dedup.checkAndAdd('city', '用户在广州做餐饮', 'agent:user-c')).toBe(false);
  });

  it('不传 scope 时保持旧的全局行为（向后兼容）', async () => {
    const value = '用户喜欢简洁的回答风格';

    expect(await dedup.checkAndAdd('style', value)).toBe(false);
    expect(await dedup.checkAndAdd('style', value)).toBe(true);
  });
});

describe('冲突检测：版本号不应被当成数值冲突', () => {
  it('1.0.0 → 2.0.0 是实体冲突，不是数值冲突', async () => {
    const r = await detectConflicts({ version: '1.0.0' }, { version: '2.0.0' });
    expect(r.hasConflict).toBe(true);
    expect(r.conflicts[0].type).toBe('entity');
  });

  it('真正的数值变化仍判为数值冲突', async () => {
    const r = await detectConflicts({ budget: '100' }, { budget: '200' });
    expect(r.hasConflict).toBe(true);
    expect(r.conflicts[0].type).toBe('numeric');
  });

  it('带千分位的金额仍是数值冲突', async () => {
    const r = await detectConflicts({ price: '1,000' }, { price: '2,000' });
    expect(r.hasConflict).toBe(true);
    expect(r.conflicts[0].type).toBe('numeric');
  });
});
