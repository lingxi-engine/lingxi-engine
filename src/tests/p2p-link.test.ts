/**
 * P2P 直连层单元测试（用注入的假 PeerConnection 工厂，不依赖 node-datachannel）
 * 覆盖：connectTo/initiator 规则、signal 路由（offer/answer/candidate）、
 *       DataChannel 消息来源校验、send 回退、stats/closePeer
 */
import { describe, it, expect, vi } from 'vitest';
import { P2PManager, type P2PSignal } from '../net/p2p-link.js';

/** 可控假 PeerConnection：记录调用、可手动触发回调 */
function makeFakePC() {
  const handlers: Record<string, Function> = {};
  const pc: any = {
    onLocalDescription: (fn: Function) => { handlers.localDesc = fn; },
    onLocalCandidate: (fn: Function) => { handlers.localCand = fn; },
    onStateChange: (fn: Function) => { handlers.state = fn; },
    onDataChannel: (fn: Function) => { handlers.dc = fn; },
    setLocalDescription: vi.fn((type: string) => {
      handlers.localDesc?.('fake-sdp-' + type.toLowerCase(), type);
    }),
    setRemoteDescription: vi.fn(),
    addRemoteCandidate: vi.fn(),
    createDataChannel: vi.fn((label: string) => makeFakeDC(label)),
    close: vi.fn(),
  };
  return { pc, handlers };
}

function makeFakeDC(label: string) {
  const handlers: Record<string, Function> = {};
  const dc: any = {
    getLabel: () => label,
    isOpen: () => true,
    sendMessage: vi.fn(() => true),
    onOpen: (fn: Function) => { handlers.open = fn; },
    onMessage: (fn: Function) => { handlers.msg = fn; },
    onClosed: (fn: Function) => { handlers.closed = fn; },
    onError: (fn: Function) => { handlers.err = fn; },
    close: vi.fn(() => handlers.closed?.()),
    _handlers: handlers,
  };
  return dc;
}

function makeManager(selfId = 'lingxi-aaaa-0001') {
  const sentSignals: { to: string; s: P2PSignal }[] = [];
  const received: { from: string; payload: any }[] = [];
  const pcs: Record<string, ReturnType<typeof makeFakePC>> = {};
  const mgr = new P2PManager({
    selfId,
    sendSignal: (to, s) => { sentSignals.push({ to, s }); return true; },
    onMessage: (from, payload) => { received.push({ from, payload }); },
    pcFactory: (name: string) => {
      const f = makeFakePC();
      pcs[name] = f;
      return f.pc;
    },
  });
  return { mgr, sentSignals, received, pcs };
}

describe('P2PManager', () => {
  it('init 在注入 pcFactory 时直接 ready', async () => {
    const { mgr } = makeManager();
    expect(await mgr.init()).toBe(true);
    expect(mgr.isReady()).toBe(true);
  });

  it('connectTo: 字典序小者为主动方（createDataChannel + 发 offer 信令）', async () => {
    const { mgr, sentSignals, pcs } = makeManager('lingxi-aaaa-0001'); // < peer
    await mgr.init();
    const ok = await mgr.connectTo('lingxi-bbbb-0002');
    expect(ok).toBe(true);
    const pc = pcs['lingxi-aaaa-0001->lingxi-bbbb-0002'].pc;
    expect(pc.createDataChannel).toHaveBeenCalled();
    expect(pc.setLocalDescription).toHaveBeenCalledWith('Offer');
    expect(sentSignals.some((x) => x.to === 'lingxi-bbbb-0002' && x.s.kind === 'offer')).toBe(true);
  });

  it('connectTo: 字典序大者不 createDataChannel，仍发 offer 由 P2PManager 内部决定 initiator', async () => {
    const { mgr, pcs } = makeManager('lingxi-zzzz-9999'); // > peer
    await mgr.init();
    await mgr.connectTo('lingxi-aaaa-0001');
    const pc = pcs['lingxi-zzzz-9999->lingxi-aaaa-0001'].pc;
    // initiator=false 时不应 createDataChannel
    expect(pc.createDataChannel).not.toHaveBeenCalled();
  });

  it('handleSignal(offer) -> 回 answer 信令', async () => {
    const { mgr, sentSignals } = makeManager();
    await mgr.init();
    mgr.handleSignal('lingxi-bbbb-0002', { kind: 'offer', sdp: 'remote-offer-sdp' });
    const pcKey = Object.keys((mgr as any).peers ? {} : {});
    // 应产生 answer 信令发回对端
    expect(sentSignals.some((x) => x.to === 'lingxi-bbbb-0002' && x.s.kind === 'answer')).toBe(true);
  });

  it('handleSignal(candidate) -> addRemoteCandidate', async () => {
    const { mgr, pcs } = makeManager('lingxi-aaaa-0001');
    await mgr.init();
    await mgr.connectTo('lingxi-bbbb-0002');
    mgr.handleSignal('lingxi-bbbb-0002', { kind: 'candidate', candidate: 'cand:1', mid: '0' });
    const pc = pcs['lingxi-aaaa-0001->lingxi-bbbb-0002'].pc;
    expect(pc.addRemoteCandidate).toHaveBeenCalledWith('cand:1', '0');
  });

  it('DataChannel 消息：来源实例不匹配则丢弃', async () => {
    const { mgr, received, pcs } = makeManager('lingxi-aaaa-0001');
    await mgr.init();
    await mgr.connectTo('lingxi-bbbb-0002');
    const pc = pcs['lingxi-aaaa-0001->lingxi-bbbb-0002'].pc;
    const dc = pc.createDataChannel.mock.results[0].value;
    // 伪造来源不符的消息
    dc._handlers.msg(JSON.stringify({ type: 'p2p.data', fromInstance: 'lingxi-evil-0000', payload: { type: 'peer.message', content: 'x' } }));
    expect(received.length).toBe(0);
    // 来源匹配则分发
    dc._handlers.msg(JSON.stringify({ type: 'p2p.data', fromInstance: 'lingxi-bbbb-0002', payload: { type: 'peer.message', content: 'hi' } }));
    expect(received.length).toBe(1);
    expect(received[0].from).toBe('lingxi-bbbb-0002');
    expect(received[0].payload.content).toBe('hi');
  });

  it('send: 未连接返回 false（调用方回退 relay）；connected 后走 dc.sendMessage', async () => {
    const { mgr, pcs } = makeManager('lingxi-aaaa-0001');
    await mgr.init();
    expect(mgr.send('lingxi-bbbb-0002', { type: 'peer.message' })).toBe(false);
    await mgr.connectTo('lingxi-bbbb-0002');
    // 模拟 connected
    (mgr as any).peers.get('lingxi-bbbb-0002').state = 'connected';
    const pc = pcs['lingxi-aaaa-0001->lingxi-bbbb-0002'].pc;
    const dc = pc.createDataChannel.mock.results[0].value;
    (mgr as any).peers.get('lingxi-bbbb-0002').dc = dc;
    const ok = mgr.send('lingxi-bbbb-0002', { type: 'peer.message', content: 'yo' });
    expect(ok).toBe(true);
    expect(dc.sendMessage).toHaveBeenCalled();
    const env = JSON.parse(dc.sendMessage.mock.calls[0][0]);
    expect(env.type).toBe('p2p.data');
    expect(env.fromInstance).toBe('lingxi-aaaa-0001');
  });

  it('超大消息 send 返回 false（回退 relay）', async () => {
    const { mgr, pcs } = makeManager('lingxi-aaaa-0001');
    await mgr.init();
    await mgr.connectTo('lingxi-bbbb-0002');
    (mgr as any).peers.get('lingxi-bbbb-0002').state = 'connected';
    const dc = pcs['lingxi-aaaa-0001->lingxi-bbbb-0002'].pc.createDataChannel.mock.results[0].value;
    (mgr as any).peers.get('lingxi-bbbb-0002').dc = dc;
    const big = 'x'.repeat(2 * 1024 * 1024); // 2MB > 1MB 上限
    expect(mgr.send('lingxi-bbbb-0002', { type: 'peer.message', content: big })).toBe(false);
  });

  it('stats / closePeer / shutdown', async () => {
    const { mgr } = makeManager();
    await mgr.init();
    await mgr.connectTo('lingxi-bbbb-0002');
    const s = mgr.stats();
    expect(s['lingxi-bbbb-0002']).toBeDefined();
    mgr.closePeer('lingxi-bbbb-0002');
    expect(mgr.stats()['lingxi-bbbb-0002']).toBeUndefined();
    mgr.shutdown(); // 不应抛错
  });

  it('connectTo 自己/空 id 返回 false', async () => {
    const { mgr } = makeManager('lingxi-aaaa-0001');
    await mgr.init();
    expect(await mgr.connectTo('lingxi-aaaa-0001')).toBe(false);
    expect(await mgr.connectTo('')).toBe(false);
  });
});
