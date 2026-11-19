/**
 * S7 跨引擎身份命名空间 — 纯函数回归测试
 * 别名格式 xlan:<instanceId>:<rawUserId>；四元组规范私聊 ID 双侧对称。
 */
import { describe, it, expect } from 'vitest';
import { xlanAlias, parseXlanAlias, isXlanAlias, makeCrossEnginePrivateChatId, XLAN_PREFIX } from '../net/lan-identity.js';

const INST_A = 'lingxi-lan-aaaaaaaaaaaa';
const INST_B = 'lingxi-lan-bbbbbbbbbbbb';

describe('xlanAlias / parseXlanAlias', () => {
  it('别名生成格式正确', () => {
    expect(xlanAlias(INST_A, '10001')).toBe('xlan:lingxi-lan-aaaaaaaaaaaa:10001');
  });

  it('roundtrip：解析还原 instanceId 与 rawUserId', () => {
    const alias = xlanAlias(INST_B, 'u-bob');
    const p = parseXlanAlias(alias);
    expect(p).toEqual({ instanceId: INST_B, rawUserId: 'u-bob' });
  });

  it('rawUserId 含冒号也能完整还原（UUID/复合 ID 兼容）', () => {
    const alias = xlanAlias(INST_A, 'ns:sub:42');
    expect(parseXlanAlias(alias)).toEqual({ instanceId: INST_A, rawUserId: 'ns:sub:42' });
  });

  it('非别名返回 null：本地 ID / remote- 占位 / 空值', () => {
    expect(parseXlanAlias('10001')).toBeNull();
    expect(parseXlanAlias('remote-10001')).toBeNull();
    expect(parseXlanAlias('u-alice')).toBeNull();
    expect(parseXlanAlias('')).toBeNull();
    expect(parseXlanAlias(null as any)).toBeNull();
    expect(parseXlanAlias('xlan:')).toBeNull();
    expect(parseXlanAlias('xlan:onlyinstance')).toBeNull();
  });

  it('isXlanAlias 判定', () => {
    expect(isXlanAlias(xlanAlias(INST_A, '10001'))).toBe(true);
    expect(isXlanAlias('10001')).toBe(false);
    expect(isXlanAlias('remote-10001')).toBe(false);
    expect(XLAN_PREFIX).toBe('xlan:');
  });

  it('不同引擎的同 ID 用户别名互异（碰撞根因消除）', () => {
    expect(xlanAlias(INST_A, '10001')).not.toBe(xlanAlias(INST_B, '10001'));
  });
});

describe('makeCrossEnginePrivateChatId 双侧对称性', () => {
  it('A 视角与 B 视角计算结果完全一致', () => {
    const fromA = makeCrossEnginePrivateChatId(INST_A, '10001', INST_B, '10001');
    const fromB = makeCrossEnginePrivateChatId(INST_B, '10001', INST_A, '10001');
    expect(fromA).toBe(fromB);
    expect(fromA.startsWith('chat-xlan-')).toBe(true);
  });

  it('跨引擎同号用户：会话 ID 含双方实例，不与本机自聊混淆', () => {
    const id = makeCrossEnginePrivateChatId(INST_A, '10001', INST_B, '10001');
    expect(id).toContain(INST_A);
    expect(id).toContain(INST_B);
    expect(id).not.toBe('chat-10001-10001');
  });

  it('不同用户对 → 不同会话 ID', () => {
    const id1 = makeCrossEnginePrivateChatId(INST_A, '10001', INST_B, '10002');
    const id2 = makeCrossEnginePrivateChatId(INST_A, '10001', INST_B, '10003');
    expect(id1).not.toBe(id2);
  });

  it('与本机-本机 makePrivateChatId 格式不冲突', () => {
    const cross = makeCrossEnginePrivateChatId(INST_A, 'u1', INST_B, 'u2');
    expect(cross.startsWith('chat-xlan-')).toBe(true);
    expect(cross.startsWith('chat-u')).toBe(false);
  });
});
