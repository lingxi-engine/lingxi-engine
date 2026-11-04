declare module 'node-datachannel' {
  export const enum DescriptionType {
    Unspec = 'Unspec',
    Offer = 'Offer',
    Answer = 'Answer',
  }
  export interface RtcConfig {
    iceServers?: (string | { hostname: string; port?: number; username?: string; password?: string })[];
    bindAddress?: string;
    enableIceTcp?: boolean;
    enableIceUdpMux?: boolean;
    disableAutoNegotiation?: boolean;
    disableAutoGathering?: boolean;
    maxMessageSize?: number;
    iceTransportPolicy?: 'all' | 'relay';
  }
  export interface DataChannelInitConfig {
    protocol?: string;
    negotiated?: boolean;
    id?: number;
    unordered?: boolean;
    maxPacketLifeTime?: number;
    maxRetransmits?: number;
  }
  export interface DataChannel {
    getLabel(): string;
    getId(): number;
    getProtocol(): string;
    close(): void;
    sendMessage(msg: string): boolean;
    sendMessageBinary(buffer: Buffer | Uint8Array): boolean;
    isOpen(): boolean;
    bufferedAmount(): number;
    maxMessageSize(): number;
    setBufferedAmountLowThreshold(n: number): void;
    onOpen(cb: () => void): void;
    onClosed(cb: () => void): void;
    onError(cb: (err: string) => void): void;
    onBufferedAmountLow(cb: () => void): void;
    onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
  }
  export interface PeerConnection {
    close(): void;
    setLocalDescription(type?: string, init?: { iceUfrag?: string; icePwd?: string }): void;
    setRemoteDescription(sdp: string, type: string): void;
    localDescription(): { type: string; sdp: string } | null;
    addRemoteCandidate(candidate: string, mid: string): void;
    createDataChannel(label: string, config?: DataChannelInitConfig): DataChannel;
    state(): string;
    iceState(): string;
    signalingState(): string;
    gatheringState(): string;
    bytesSent(): number;
    bytesReceived(): number;
    rtt(): number;
    onLocalDescription(cb: (sdp: string, type: string) => void): void;
    onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
    onStateChange(cb: (state: string) => void): void;
    onIceStateChange(cb: (state: string) => void): void;
    onSignalingStateChange(cb: (state: string) => void): void;
    onGatheringStateChange(cb: (state: string) => void): void;
    onDataChannel(cb: (dc: DataChannel) => void): void;
  }
  export function initLogger(level?: string, cb?: (level: string, message: string) => void): void;
  export function cleanup(): void;
  export function preload(): void;
  export function getLibraryVersion(): string;
  const _default: any;
  export default _default;
}
