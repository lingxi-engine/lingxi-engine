import { describe, expect, it } from 'vitest';
import { scheduleMemoryForReply, isRevocationFact } from '../memory-scheduler.js';

describe('scheduleMemoryForReply', () => {
  const facts = [
    { key: 'city', value: '用户在上海做外贸' },
    { key: 'diet', value: '不吃香菜' },
    { key: 'diet_fix', value: '香菜那个作废，现在吃' },
    { key: 'budget', value: '预算 200' },
    { key: 'name', value: '张三' },
  ];

  it('写德语邮件时不想起香菜和姓名', () => {
    const r = scheduleMemoryForReply({
      query: '帮我写一封给德国客户的邮件',
      facts,
      summary: '第一天说在上海做外贸。后来改口吃香菜。',
    });
    const keys = r.facts.map(f => f.key);
    expect(keys).toContain('diet_fix');
    expect(keys).not.toContain('city');
    expect(keys).not.toContain('diet');
    expect(keys).not.toContain('name');
    expect(keys).not.toContain('budget');
  });

  it('报价场景才想起预算', () => {
    const r = scheduleMemoryForReply({
      query: '这封邮件里加上报价和预算',
      facts,
    });
    expect(r.facts.map(f => f.key)).toContain('budget');
  });

  it('自我介绍才放身份', () => {
    const r = scheduleMemoryForReply({
      query: '帮我写一段自我介绍，带上名字和城市',
      facts,
    });
    expect(r.facts.map(f => f.key)).toEqual(expect.arrayContaining(['name', 'city']));
  });

  it('作废事实永远入选且最多 5 条', () => {
    const many = [
      { key: 'rev', value: '旧设定作废' },
      ...Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, value: `外贸客户条款${i}` })),
    ];
    const r = scheduleMemoryForReply({ query: '写给外贸客户的条款', facts: many, maxFacts: 5 });
    expect(r.facts).toHaveLength(5);
    expect(r.facts[0].key).toBe('rev');
    expect(r.dropped).toBe(8);
  });

  it('摘要只留和当前句重叠的行', () => {
    const r = scheduleMemoryForReply({
      query: '德国客户邮件',
      facts: [],
      summary: '今天聊了香菜。\n用户在上海做外贸，要联系德国客户。',
    });
    expect(r.summary).toContain('德国客户');
    expect(r.summary).not.toContain('香菜');
  });

  it('识别作废词', () => {
    expect(isRevocationFact({ key: 'x', value: '市场不用了' })).toBe(true);
    expect(isRevocationFact({ key: 'x', value: '喜欢聊天' })).toBe(false);
  });
});
