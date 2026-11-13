/**
 * B4/B7/B9/B10 回归测试：Mesh 签名与限流
 *
 * 锁死不变式：
 *   1. Ed25519 sign/verify 往返可用（B4 根因：原 createSign('ed25519') 抛 Invalid digest）
 *   2. 篡改/非法密钥一律拒绝，verify 不抛异常
 *   3. payload 含 senderId/senderName；undefined 字段省略 → 旧消息签名字节不变（向后兼容）
 *   4. 联邦密钥对持久化到 dataDir 且跨加载稳定
 *   5. 防重放：±5 分钟时间窗、fromInstance 一致性、已用签名缓存
 *   6. 限流响应头反映真实 maxPerMinute（B9）；自定义窗口正确重置（B10）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateKeyPairSync,
  sign,
  verify,
  signMeshMessage,
  verifyMeshMessage,
  buildMeshMessagePayload,
  loadOrCreateFederationKeyPair,
  verifyMeshSignature,
  checkRateLimit,
  meshMessageRateLimit,
  friendRequestRateLimit,
  toBase64URL,
  REPLAY_WINDOW_MS,
} from '../core/mesh-security.js';

const kp = generateKeyPairSync();
let tmpDir: string;
let seq = 0;
/** 每个用例用独立实例 ID，避免模块级重放缓存跨用例串扰 */
function freshInstance() { return `test-inst-${Date.now()}-${seq++}`; }

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: null as any,
    headers: {} as Record<string, string>,
    status(c: number) { res.statusCode = c; return res; },
    json(b: any) { res.body = b; return res; },
    setHeader(k: string, v: string) { res.headers[k] = v; },
  };
  return res;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sec-test-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('B4 根因: Ed25519 sign/verify 必须真正可用', () => {
  it('签名→验签往返成功', () => {
    const sig = sign('hello world', kp.privateKey);
    expect(verify('hello world', sig, kp.publicKey)).toBe(true);
  });

  it('篡改消息拒绝', () => {
    const sig = sign('hello world', kp.privateKey);
    expect(verify('hello worlD', sig, kp.publicKey)).toBe(false);
  });

  it('错误公钥拒绝', () => {
    const other = generateKeyPairSync();
    const sig = sign('msg', kp.privateKey);
    expect(verify('msg', sig, other.publicKey)).toBe(false);
  });

  it('非法密钥/签名返回 false 而不抛异常', () => {
    expect(verify('msg', Buffer.from('x'), Buffer.from('garbage'))).toBe(false);
    expect(() => sign('msg', Buffer.from('garbage'))).toThrow(); // 私钥非法允许抛（调用方错误）
  });

  it('Uint8Array 与 string 输入等价', () => {
    const sig = sign(Buffer.from('abc'), kp.privateKey);
    expect(verify('abc', sig, kp.publicKey)).toBe(true);
  });
});

describe('B4: 签名载荷与向后兼容', () => {
  it('payload 包含 senderId/senderName', () => {
    const msg = { chatId: 'c', content: 'x', senderId: 'u1', senderName: 'Alice', timestamp: 1 };
    const parsed = JSON.parse(buildMeshMessagePayload(msg).toString('utf8'));
    expect(parsed.senderId).toBe('u1');
    expect(parsed.senderName).toBe('Alice');
  });

  it('undefined 字段被省略 → 旧消息（无 senderId）签名字节不变', () => {
    const oldMsg = { type: 'peer.message', fromInstance: 'i', content: 'x', timestamp: 1 };
    const parsed = JSON.parse(buildMeshMessagePayload(oldMsg).toString('utf8'));
    expect('senderId' in parsed).toBe(false);
    expect('senderName' in parsed).toBe(false);
    expect(verifyMeshMessage(oldMsg, signMeshMessage(oldMsg, kp.privateKey), kp.publicKey)).toBe(true);
  });

  it('signMeshMessage/verifyMeshMessage 往返 + 篡改拒绝', () => {
    const msg = { type: 'federation.message', fromInstance: 'i', chatId: 'c', content: 'hi', senderId: 'u', senderName: 'N', timestamp: Date.now() };
    const sig = signMeshMessage(msg, kp.privateKey);
    expect(verifyMeshMessage(msg, sig, kp.publicKey)).toBe(true);
    expect(verifyMeshMessage({ ...msg, content: 'evil' }, sig, kp.publicKey)).toBe(false);
  });
});

describe('B4: 联邦密钥对持久化', () => {
  it('首次创建并写盘，二次加载稳定', () => {
    const a = loadOrCreateFederationKeyPair(tmpDir);
    const file = path.join(tmpDir, 'federation-ed25519.json');
    expect(fs.existsSync(file)).toBe(true);
    const b = loadOrCreateFederationKeyPair(tmpDir);
    expect(a.publicKey.equals(b.publicKey)).toBe(true);
    expect(a.privateKey.equals(b.privateKey)).toBe(true);
  });

  it('加载的密钥可签名验签', () => {
    const k = loadOrCreateFederationKeyPair(tmpDir);
    const sig = sign('probe', k.privateKey);
    expect(verify('probe', sig, k.publicKey)).toBe(true);
  });

  it('损坏文件自动重新生成', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sec-corrupt-'));
    fs.writeFileSync(path.join(dir, 'federation-ed25519.json'), '{corrupt!!');
    const k = loadOrCreateFederationKeyPair(dir);
    expect(verify('p', sign('p', k.privateKey), k.publicKey)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('B7: verifyMeshSignature 防重放', () => {
  function makeMsg(instanceId: string, over: any = {}) {
    return { type: 'federation.message', fromInstance: instanceId, chatId: 'c1', content: 'hi', senderId: 'u1', senderName: 'A', timestamp: Date.now(), ...over };
  }
  function run(mw: any, msg: any, headers: any) {
    const res = mockRes();
    let passed = false;
    mw({ body: msg, headers }, res, () => { passed = true; });
    return { res, passed };
  }

  it('合法签名消息放行', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst);
    const sig = signMeshMessage(msg, kp.privateKey);
    const { passed } = run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst });
    expect(passed).toBe(true);
  });

  it('同一签名重放被拒绝', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst);
    const sig = signMeshMessage(msg, kp.privateKey);
    const headers = { 'x-signature': sig, 'x-instance-id': inst };
    expect(run(mw, msg, headers).passed).toBe(true);
    const second = run(mw, msg, headers);
    expect(second.passed).toBe(false);
    expect(second.res.statusCode).toBe(403);
    expect(second.res.body.error).toContain('重放');
  });

  it('过期时间戳（超出 ±5 分钟）拒绝', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst, { timestamp: Date.now() - REPLAY_WINDOW_MS - 1000 });
    const sig = signMeshMessage(msg, kp.privateKey);
    const { res, passed } = run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('未来时间戳（超出 +5 分钟）同样拒绝', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst, { timestamp: Date.now() + REPLAY_WINDOW_MS + 1000 });
    const sig = signMeshMessage(msg, kp.privateKey);
    expect(run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst }).passed).toBe(false);
  });

  it('缺失时间戳拒绝', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst, { timestamp: undefined });
    const sig = signMeshMessage(msg, kp.privateKey);
    expect(run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst }).passed).toBe(false);
  });

  it('fromInstance 与请求头不一致拒绝（冒名转发）', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst, { fromInstance: 'someone-else' });
    const sig = signMeshMessage(msg, kp.privateKey);
    const { res, passed } = run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('缺签名/缺实例 ID → 400', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature(() => kp.publicKey);
    expect(run(mw, makeMsg(inst), { 'x-instance-id': inst }).res.statusCode).toBe(400);
    expect(run(mw, makeMsg(inst), { 'x-signature': 'x' }).res.statusCode).toBe(400);
  });

  it('未知实例（无钉住公钥）→ 403', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature(() => null);
    const msg = makeMsg(inst);
    const sig = signMeshMessage(msg, kp.privateKey);
    expect(run(mw, msg, { 'x-signature': sig, 'x-instance-id': inst }).res.statusCode).toBe(403);
  });

  it('篡改 body 后签名失效 → 403', () => {
    const inst = freshInstance();
    const mw = verifyMeshSignature((id) => (id === inst ? kp.publicKey : null));
    const msg = makeMsg(inst);
    const sig = signMeshMessage(msg, kp.privateKey);
    const { res, passed } = run(mw, { ...msg, content: 'evil' }, { 'x-signature': sig, 'x-instance-id': inst });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('B9/B10: 限流', () => {
  it('B9: 响应头反映真实 maxPerMinute（非硬编码）', () => {
    const mw = meshMessageRateLimit(7);
    const res = mockRes();
    let passed = false;
    mw({ headers: { 'x-instance-id': freshInstance() }, ip: '1.2.3.4' }, res, () => { passed = true; });
    expect(passed).toBe(true);
    expect(res.headers['X-RateLimit-Limit']).toBe('7');
  });

  it('B9: friendRequestRateLimit 自定义值同样反映', () => {
    const mw = friendRequestRateLimit(9);
    const res = mockRes();
    mw({ user: { sub: 'u-' + freshInstance() }, ip: '1.2.3.4' }, res, () => {});
    expect(res.headers['X-RateLimit-Limit']).toBe('9');
  });

  it('超限返回 429 且 remaining 递减', () => {
    const inst = freshInstance();
    const mw = meshMessageRateLimit(2);
    const r1 = mockRes(); const r2 = mockRes(); const r3 = mockRes();
    let n = 0;
    const req = { headers: { 'x-instance-id': inst }, ip: '1.2.3.4' };
    mw(req, r1, () => { n++; });
    mw(req, r2, () => { n++; });
    mw(req, r3, () => { n++; });
    expect(n).toBe(2);
    expect(r3.statusCode).toBe(429);
    expect(r1.headers['X-RateLimit-Remaining']).toBe('1');
    expect(r2.headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('B10: 自定义短窗口到期后正确重置', async () => {
    const key = 'b10-window-' + Date.now();
    expect(checkRateLimit(key, 1, 60).allowed).toBe(true);
    expect(checkRateLimit(key, 1, 60).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(checkRateLimit(key, 1, 60).allowed).toBe(true);
  });

  it('B10: 长窗口桶不受短窗口清理逻辑影响（窗口内持续计数）', () => {
    const key = 'b10-long-' + Date.now();
    expect(checkRateLimit(key, 2, 300000).allowed).toBe(true);
    expect(checkRateLimit(key, 2, 300000).allowed).toBe(true);
    const third = checkRateLimit(key, 2, 300000);
    expect(third.allowed).toBe(false);
    expect(third.resetAt).toBeGreaterThan(Date.now() + 200000);
  });
});
