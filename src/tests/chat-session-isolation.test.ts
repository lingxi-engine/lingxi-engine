/**
 * 会话隔离 — 集成测试
 *
 * 背景：用户报告「会话 A 里发的消息，点进会话 B 也会显示」。
 *
 * 根因（两层）：
 *   1. 服务端：wsSubscriptions 只增不减，前端切会话从不退订，
 *      服务端会把所有历史会话的事件都推给同一个 WS 连接。
 *   2. 前端：appendStreamingMsg 没有 chatId 过滤（appendMessage 有），
 *      导致会话 A 的流式 AI 回复气泡被塞进会话 B 的消息区。
 *
 * 覆盖：
 *   - subscribe → 订阅集合增加 chatId
 *   - unsubscribe → 订阅集合移除该 chatId（本次修复新增）
 *   - 退订后，broadcast 的 chatId 过滤不再向该连接投递旧会话事件
 *   - 退订不影响其他连接的订阅
 *   - 无 chatId 的全局事件不受订阅影响
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleWSMessage, wsSubscriptions } from '../core/ws-handler.js';

function fakeWs() {
  const sent: any[] = [];
  return {
    readyState: 1,
    sent,
    send(payload: string) { sent.push(JSON.parse(payload)); },
  } as any;
}

function makeBroadcast(clients: Map<string, Set<any>>) {
  return (event: any) => {
    const payload = JSON.stringify(event);
    const eventChatId = event.chatId;
    for (const [, set] of clients) {
      for (const ws of set) {
        if (ws.readyState !== 1) continue;
        if (eventChatId) {
          const subs = wsSubscriptions.get(ws);
          if (!subs || !subs.has(eventChatId)) continue;
        }
        ws.send(payload);
      }
    }
  };
}

const router = {} as any;

describe('会话隔离 — WS 订阅管理', () => {
  let ws: any;
  let clients: Map<string, Set<any>>;

  beforeEach(() => {
    ws = fakeWs();
    clients = new Map([['u1', new Set([ws])]]);
  });

  it('subscribe → 订阅集合包含该 chatId', () => {
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u1', router, () => {}, ws);
    expect(wsSubscriptions.get(ws)!.has('chat-A')).toBe(true);
  });

  it('unsubscribe → 订阅集合移除该 chatId（本次修复新增）', () => {
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u1', router, () => {}, ws);
    handleWSMessage(JSON.stringify({ type: 'unsubscribe', chatId: 'chat-A' }), 'u1', router, () => {}, ws);
    expect(wsSubscriptions.get(ws)!.has('chat-A')).toBe(false);
  });

  it('退订旧会话后，旧会话事件不再投递到该连接', () => {
    const broadcast = makeBroadcast(clients);
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-B' }), 'u1', router, broadcast, ws);
    handleWSMessage(JSON.stringify({ type: 'unsubscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    ws.sent.length = 0;
    broadcast({ type: 'agent.streaming.start', chatId: 'chat-A', msgId: 'm1' });
    broadcast({ type: 'agent.streaming.start', chatId: 'chat-B', msgId: 'm2' });
    const chatIds = ws.sent.map((e: any) => e.chatId);
    expect(chatIds).not.toContain('chat-A');
    expect(chatIds).toContain('chat-B');
  });

  it('退订不影响其他连接的订阅', () => {
    const ws2 = fakeWs();
    clients.set('u2', new Set([ws2]));
    const broadcast = makeBroadcast(clients);
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u2', router, broadcast, ws2);
    handleWSMessage(JSON.stringify({ type: 'unsubscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    ws.sent.length = 0; ws2.sent.length = 0;
    broadcast({ type: 'message.new', chatId: 'chat-A', content: 'hi' });
    expect(ws.sent.length).toBe(0);
    expect(ws2.sent.length).toBe(1);
  });

  it('无 chatId 的全局事件（online/offline）不受订阅影响', () => {
    const broadcast = makeBroadcast(clients);
    handleWSMessage(JSON.stringify({ type: 'subscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    handleWSMessage(JSON.stringify({ type: 'unsubscribe', chatId: 'chat-A' }), 'u1', router, broadcast, ws);
    ws.sent.length = 0;
    broadcast({ type: 'user.online', userId: 'u2' });
    expect(ws.sent.length).toBe(1);
  });
});
