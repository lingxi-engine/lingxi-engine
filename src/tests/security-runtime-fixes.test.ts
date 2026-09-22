import { describe, it, expect, vi } from 'vitest';
import { verifyWeChatWebhook } from '../routes/webhook-auth.js';
import { timingSafeTokenEqual } from '../security/token-compare.js';
import { isFinitePositiveAmount } from '../storage/amount-guards.js';
import { buildFriendRequestLookup } from '../storage/friend-guards.js';

describe('security/runtime fixes', () => {
  it('amount guard rejects invalid values', () => {
    expect(isFinitePositiveAmount(1)).toBe(true);
    expect(isFinitePositiveAmount(0)).toBe(false);
    expect(isFinitePositiveAmount(-1)).toBe(false);
    expect(isFinitePositiveAmount(Number.NaN)).toBe(false);
    expect(isFinitePositiveAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('friend request lookup enforces to_user_id when responder is provided', () => {
    const owned = buildFriendRequestLookup('u2');
    expect(owned.sql).toContain('to_user_id');
    expect(owned.params).toEqual(['u2']);
    const legacy = buildFriendRequestLookup();
    expect(legacy.sql).not.toContain('to_user_id = ?');
  });

  it('verifies WeChat POST/GET signature consistently', () => {
    const adapter = { verifySignature: vi.fn(() => true) } as any;
    expect(verifyWeChatWebhook(adapter, { signature: 's', timestamp: '1', nonce: '2' })).toBe(true);
    expect(verifyWeChatWebhook(adapter, { msg_signature: 's', timestamp: '1', nonce: '2' })).toBe(true);
    expect(verifyWeChatWebhook(adapter, { signature: 's', nonce: '2' })).toBe(false);
  });

  it('uses timing-safe token comparison helper', () => {
    expect(timingSafeTokenEqual('abc', 'abc')).toBe(true);
    expect(timingSafeTokenEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeTokenEqual('abc', 'abd')).toBe(false);
  });

});
