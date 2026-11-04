/**
 * P2P 直连层 (WebRTC DataChannel over Mesh signaling)
 *
 * 把 Mesh 从「中心 relay」升级为「信令 + 兜底」：
 *   - 信令（offer/answer/ICE candidate）仍走平台 WebSocket /mesh 中继（peer.signal 消息）
 *   - 一旦 DataChannel 打通，peer 消息直接 P2P 走 DataChannel，不再经过平台
 *   - DataChannel 断开/未建立时，自动回退到 relay（sendPeerMessage），业务无感知
 *
 * 依赖 node-datachannel（optionalDependency，缺失时本模块整体降级为纯 relay）
 * 开关：MESH_P2P=0 关闭（默认开启）
 * STUN：P2P_STUN 环境变量逗号分隔，默认 Google 公共 STUN
 */

export type P2PSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; mid: string };

export interface P2PManagerOptions {
  selfId: string;
  /** 通过 mesh relay 发送信令（返回 false 表示 relay 也不通） */
  sendSignal: (toInstance: string, signal: P2PSignal) => boolean;
  /** 收到 P2P DataChannel 消息（payload 为 PeerMessage） */
  onMessage: (fromInstance: string, payload: any) => void;
  stunServers?: string[];
  enabled?: boolean;
  /** 测试钩子：注入 PeerConnection 工厂（默认动态加载 node-datachannel） */
  pcFactory?: (name: string, config: any) => any;
}

interface PeerConn {
  pc: any;
  dc: any | null;
  state: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
  initiator: boolean;
  lastActivity: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

const DC_LABEL = 'lingxi';
const RECONNECT_DELAY_MS = 8000;
const MAX_MSG = 1 << 20; // 1MB datachannel 上限兜底

export class P2PManager {
  private selfId: string;
  private sendSignalFn: (to: string, s: P2PSignal) => boolean;
  private onMessageFn: (from: string, payload: any) => void;
  private stun: string[];
  private enabled: boolean;
  private pcFactoryFn?: (name: string, config: any) => any;
  private peers = new Map<string, PeerConn>();
  private ready = false;
  private dcLib: any = null;

  constructor(opts: P2PManagerOptions) {
    this.selfId = opts.selfId;
    this.sendSignalFn = opts.sendSignal;
    this.onMessageFn = opts.onMessage;
    this.stun = opts.stunServers?.length ? opts.stunServers : DEFAULT_STUN;
    this.enabled = opts.enabled !== false;
    this.pcFactoryFn = opts.pcFactory;
  }

  /** 动态加载 node-datachannel；缺失返回 false（整体降级 relay） */
  async init(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.pcFactoryFn) { this.ready = true; return true; }
    try {
      const mod: any = await import('node-datachannel');
      this.dcLib = mod.default || mod;
      try { this.dcLib.initLogger?.('Warning'); } catch { /* ignore */ }
      this.ready = true;
      return true;
    } catch (e: any) {
      console.warn('[P2P] node-datachannel 不可用，降级为纯 relay 模式:', e?.message || e);
      return false;
    }
  }

  isReady(): boolean { return this.ready; }

  private createPC(peerId: string, initiator: boolean): PeerConn {
    const factory = this.pcFactoryFn || ((name: string, config: any) => new this.dcLib.PeerConnection(name, config));
    const pc = factory(`${this.selfId}->${peerId}`, { iceServers: this.stun });
    const conn: PeerConn = { pc, dc: null, state: 'new', initiator, lastActivity: Date.now() };

    pc.onLocalDescription((sdp: string, type: string) => {
      // type: 'Offer' | 'Answer'
      const kind = String(type).toLowerCase() === 'offer' ? 'offer' : 'answer';
      this.sendSignalFn(peerId, { kind, sdp } as P2PSignal);
    });
    pc.onLocalCandidate((candidate: string, mid: string) => {
      if (candidate) this.sendSignalFn(peerId, { kind: 'candidate', candidate, mid });
    });
    pc.onStateChange((state: string) => {
      const s = String(state).toLowerCase();
      if (s === 'connected') {
        conn.state = 'connected';
        conn.lastActivity = Date.now();
        console.log(`[P2P] DataChannel 已打通: ${this.selfId} <-> ${peerId}`);
      } else if (s === 'disconnected' || s === 'failed') {
        conn.state = s === 'failed' ? 'failed' : 'disconnected';
        console.warn(`[P2P] 连接状态 ${s}: ${peerId}，${RECONNECT_DELAY_MS / 1000}s 后重连`);
        this.scheduleReconnect(peerId);
      } else if (s === 'closed') {
        conn.state = 'closed';
      }
    });
    pc.onDataChannel((dc: any) => {
      this.attachDC(peerId, conn, dc);
    });

    this.peers.set(peerId, conn);
    return conn;
  }

  private attachDC(peerId: string, conn: PeerConn, dc: any) {
    if (dc.getLabel?.() && dc.getLabel() !== DC_LABEL) return;
    conn.dc = dc;
    dc.onOpen?.(() => {
      conn.state = 'connected';
      conn.lastActivity = Date.now();
      console.log(`[P2P] DataChannel open: ${this.selfId} <-> ${peerId}`);
    });
    dc.onMessage?.((raw: string | Buffer) => {
      conn.lastActivity = Date.now();
      try {
        const env = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        // 防篡改：校验来源实例 ID 与信令对端一致
        if (env && env.type === 'p2p.data' && env.fromInstance === peerId) {
          this.onMessageFn(peerId, env.payload);
        } else {
          console.warn(`[P2P] 丢弃来源不匹配的消息 from=${env?.fromInstance} expected=${peerId}`);
        }
      } catch { /* 非 JSON 忽略 */ }
    });
    dc.onClosed?.(() => {
      if (conn.dc === dc) conn.dc = null;
      if (conn.state === 'connected') {
        conn.state = 'disconnected';
        this.scheduleReconnect(peerId);
      }
    });
    dc.onError?.((err: string) => { console.warn(`[P2P] dc error ${peerId}:`, err); });
  }

  private scheduleReconnect(peerId: string) {
    const conn = this.peers.get(peerId);
    if (!conn || conn.reconnectTimer) return;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      if (conn.state === 'closed') return;
      // 防 glare：字典序小者主动 offer
      if (this.selfId < peerId) {
        this.connectTo(peerId).catch(() => {});
      } else {
        // 等对方发起；但对方可能已挂，兜底：标记 disconnected 由对端重连
        conn.state = 'disconnected';
      }
    }, RECONNECT_DELAY_MS);
    if (typeof (conn.reconnectTimer as any).unref === 'function') (conn.reconnectTimer as any).unref();
  }

  /** 主动向 peer 发起连接（initiator 规则：selfId < peerId 时本方 createDataChannel） */
  async connectTo(peerId: string): Promise<boolean> {
    if (!this.ready || !peerId || peerId === this.selfId) return false;
    const existing = this.peers.get(peerId);
    if (existing && (existing.state === 'connected' || existing.state === 'connecting')) return true;
    const initiator = this.selfId < peerId;
    const conn = this.createPC(peerId, initiator);
    conn.state = 'connecting';
    try {
      if (initiator) {
        const dc = conn.pc.createDataChannel(DC_LABEL, { ordered: true });
        this.attachDC(peerId, conn, dc);
      }
      conn.pc.setLocalDescription('Offer');
    } catch (e: any) {
      console.warn(`[P2P] 发起连接失败 ${peerId}:`, e?.message || e);
      conn.state = 'failed';
      return false;
    }
    return true;
  }

  /** 处理来自 mesh relay 的信令 */
  handleSignal(fromInstance: string, signal: P2PSignal): void {
    if (!this.ready || !fromInstance || fromInstance === this.selfId) return;
    if (!signal || !signal.kind) return;
    let conn = this.peers.get(fromInstance);

    if (signal.kind === 'offer') {
      // 对方发 offer → 本方应答（无论字典序，收到 offer 就回 answer，避免 glare 死锁）
      if (!conn || conn.state === 'failed' || conn.state === 'closed') {
        conn = this.createPC(fromInstance, false);
      }
      try {
        conn.pc.setRemoteDescription(signal.sdp, 'Offer');
        conn.pc.setLocalDescription('Answer');
        conn.state = 'connecting';
      } catch (e: any) {
        console.warn(`[P2P] 处理 offer 失败 ${fromInstance}:`, e?.message || e);
      }
      return;
    }
    if (!conn) return;
    if (signal.kind === 'answer') {
      try {
        conn.pc.setRemoteDescription(signal.sdp, 'Answer');
        conn.state = 'connecting';
      } catch (e: any) {
        console.warn(`[P2P] 处理 answer 失败 ${fromInstance}:`, e?.message || e);
      }
      return;
    }
    if (signal.kind === 'candidate') {
      try { conn.pc.addRemoteCandidate(signal.candidate, signal.mid); } catch { /* 忽略过期 candidate */ }
    }
  }

  /** 是否与 peer 有可用 DataChannel */
  isConnected(peerId: string): boolean {
    const c = this.peers.get(peerId);
    return !!(c && c.state === 'connected' && c.dc && c.dc.isOpen?.() !== false);
  }

  /** 走 DataChannel 发消息；不可用返回 false（调用方回退 relay） */
  send(peerId: string, payload: any): boolean {
    const c = this.peers.get(peerId);
    if (!c || !c.dc || c.state !== 'connected') return false;
    try {
      const env = JSON.stringify({ type: 'p2p.data', fromInstance: this.selfId, payload });
      if (env.length > MAX_MSG) {
        console.warn(`[P2P] 消息过大丢弃 (${env.length}B) -> ${peerId}，回退 relay`);
        return false;
      }
      const ok = c.dc.sendMessage(env);
      if (ok) c.lastActivity = Date.now();
      return !!ok;
    } catch {
      return false;
    }
  }

  /** 状态摘要（给 /api/mesh/status） */
  stats(): Record<string, { state: string; initiator: boolean; lastActivity: number }> {
    const out: Record<string, { state: string; initiator: boolean; lastActivity: number }> = {};
    for (const [id, c] of this.peers) {
      out[id] = { state: c.state, initiator: c.initiator, lastActivity: c.lastActivity };
    }
    return out;
  }

  closePeer(peerId: string): void {
    const c = this.peers.get(peerId);
    if (!c) return;
    c.state = 'closed';
    if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = undefined; }
    try { c.dc?.close?.(); } catch { /* ignore */ }
    try { c.pc?.close?.(); } catch { /* ignore */ }
    this.peers.delete(peerId);
  }

  shutdown(): void {
    for (const id of Array.from(this.peers.keys())) this.closePeer(id);
    try { this.dcLib?.cleanup?.(); } catch { /* ignore */ }
  }
}
