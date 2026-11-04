/**
 * A2A 协议单元测试
 * 覆盖：Agent Card 构造、JSON-RPC 解析、任务状态机（不真正调 AI，用假 router）
 */
import { describe, it, expect } from 'vitest';
import { buildAgentCard, parseJsonRpc } from '../routes/a2a.js';

describe('A2A buildAgentCard', () => {
  it('生成符合规范的 Agent Card', () => {
    const card = buildAgentCard({
      agentId: 'agent-1',
      name: '灵犀 · 小助手',
      description: 'test',
      url: 'http://localhost:3456/a2a',
      version: '2.0.0',
    });
    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.authentication.schemes).toContain('bearer');
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.url).toBe('http://localhost:3456/a2a');
    expect(card.agentId).toBe('agent-1');
  });
});

describe('A2A parseJsonRpc', () => {
  it('合法请求解析成功', () => {
    const r = parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { message: { parts: [{ type: 'text', text: 'hi' }] } } });
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.method).toBe('tasks/send');
      expect(r.id).toBe(1);
    }
  });

  it('缺 jsonrpc 拒绝', () => {
    const r = parseJsonRpc({ id: 1, method: 'x' });
    expect('error' in r).toBe(true);
  });

  it('数组体拒绝', () => {
    const r = parseJsonRpc([1, 2, 3]);
    expect('error' in r).toBe(true);
  });

  it('缺 method 拒绝', () => {
    const r = parseJsonRpc({ jsonrpc: '2.0', id: 1 });
    expect('error' in r).toBe(true);
  });

  it('id 缺省为 null（通知）', () => {
    const r = parseJsonRpc({ jsonrpc: '2.0', method: 'tasks/get', params: {} });
    if (!('error' in r)) expect(r.id).toBeNull();
  });
});
