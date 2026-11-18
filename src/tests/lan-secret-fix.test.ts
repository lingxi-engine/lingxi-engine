/**
 * 跨引擎「加好友加不上」修复回归测试（2026-11-18）
 *
 * 根因：P1-B 曾为每台引擎自动生成随机 LAN_SECRET 写入 .env 做局域网 HMAC 鉴权。
 *       per-instance 随机密钥彼此不同 → 跨引擎签名必不匹配 → 对端 403「局域网签名校验失败」→ 加好友加不上。
 * 修复：neutralizeAutoLanSecret 把「带 P1-B 自动标记」的 LAN_SECRET 改名为 LAN_LOCAL_SECRET（退出鉴权）；
 *       用户手动设置的共享密钥原样保留；默认空 = 仅协议头识别，跨引擎开箱即用。
 *
 * 本文件两组测试：
 *  A. neutralizeAutoLanSecret 纯函数（迁移/保留/幂等/EOL/空行）
 *  B. verifyLanRequest 跨引擎鉴权（默认直通 / 异密钥 403 复现 / 同密钥通过 / 缺协议头 403）
 * 全部不碰生产 .env、不碰生产数据库。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'crypto';
import { neutralizeAutoLanSecret, verifyLanRequest } from '../net/lan-transport.js';

const AUTO_MARKER = '# Auto-generated on first boot (P1-B): per-instance LAN HMAC secret';

describe('A. neutralizeAutoLanSecret 纯函数', () => {
  it('A1 自动生成的 LAN_SECRET 被迁移为 LAN_LOCAL_SECRET，migrated=true', () => {
    const env = `${AUTO_MARKER}\nLAN_SECRET=9e0be4deadbeef\nOTHER=keep\n`;
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(true);
    expect(text).toContain('LAN_LOCAL_SECRET=9e0be4deadbeef');
    // 不再有「生效的」LAN_SECRET= 行（注释里的提示文字不算）
    const active = text.split(/\r?\n/).filter((l) => /^LAN_SECRET\s*=/.test(l));
    expect(active.length).toBe(0);
    // 其它配置原样保留
    expect(text).toContain('OTHER=keep');
  });

  it('A2 用户手动设置的 LAN_SECRET（无自动标记）原样保留，migrated=false', () => {
    const env = '# 我自己设的共享密钥\nLAN_SECRET=my-shared-key\n';
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(false);
    expect(text).toBe(env);
    expect(text).toContain('LAN_SECRET=my-shared-key');
    expect(text).not.toContain('LAN_LOCAL_SECRET');
  });

  it('A3 幂等：已迁移文本再跑一次不变，migrated=false', () => {
    const env = `${AUTO_MARKER}\nLAN_SECRET=abc123\n`;
    const first = neutralizeAutoLanSecret(env);
    expect(first.migrated).toBe(true);
    const second = neutralizeAutoLanSecret(first.text);
    expect(second.migrated).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it('A4 完全没有 LAN_SECRET：原样返回，migrated=false', () => {
    const env = 'PORT=3456\nDEFAULT_MODEL=qwen4-max-preview\n';
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(false);
    expect(text).toBe(env);
  });

  it('A5 空 .env：原样返回，migrated=false', () => {
    const { text, migrated } = neutralizeAutoLanSecret('');
    expect(migrated).toBe(false);
    expect(text).toBe('');
  });

  it('A6 CRLF 行尾被保留', () => {
    const env = `${AUTO_MARKER}\r\nLAN_SECRET=crlfkey\r\nX=1\r\n`;
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(true);
    expect(text).toContain('LAN_LOCAL_SECRET=crlfkey');
    expect(text.includes('\r\n')).toBe(true);
    // 不应混入裸 LF（除 CRLF 外）
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('A7 标记与 LAN_SECRET 之间有空行也能识别（while 跳过空行）', () => {
    const env = `${AUTO_MARKER}\n\n\nLAN_SECRET=blanklinekey\n`;
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(true);
    expect(text).toContain('LAN_LOCAL_SECRET=blanklinekey');
  });

  it('A8 标记在文件中间、前面有其它配置：只迁移目标行', () => {
    const env = `PORT=3456\n${AUTO_MARKER}\nLAN_SECRET=midkey\nTAIL=2\n`;
    const { text, migrated } = neutralizeAutoLanSecret(env);
    expect(migrated).toBe(true);
    expect(text).toContain('PORT=3456');
    expect(text).toContain('TAIL=2');
    expect(text).toContain('LAN_LOCAL_SECRET=midkey');
  });
});

describe('B. verifyLanRequest 跨引擎鉴权（好友请求闸）', () => {
  const origSecret = process.env.LAN_SECRET;
  afterEach(() => {
    if (origSecret === undefined) delete process.env.LAN_SECRET;
    else process.env.LAN_SECRET = origSecret;
  });

  function fakeRes() {
    const r: any = { code: 0, body: null };
    r.status = (c: number) => { r.code = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
  }
  const PATH = '/api/lan/peer/friend-request';
  const BODY = { fromUserId: 'u-a', toUserId: 'u-b', message: '加个好友' };

  function signedHeaders(secret: string, from: string) {
    const timestamp = Date.now().toString();
    const nonce = randomBytes(16).toString('hex');
    const sig = createHmac('sha256', secret)
      .update(timestamp + ':' + nonce + ':' + PATH + ':' + JSON.stringify(BODY))
      .digest('hex');
    return {
      'x-lingxi-lan-proto': '1',
      'x-lingxi-from': from,
      'x-lingxi-secret': sig,
      'x-lingxi-ts': timestamp,
      'x-lingxi-nonce': nonce,
    };
  }

  it('B1 默认无密钥（修复后）：仅协议头即直通，跨引擎开箱即用', () => {
    delete process.env.LAN_SECRET;
    const req: any = {
      headers: { 'x-lingxi-lan-proto': '1', 'x-lingxi-from': 'engine-A' },
      method: 'POST', path: PATH, body: BODY,
    };
    const res = fakeRes();
    const from = verifyLanRequest(req, res);
    expect(from).toBe('engine-A');
    expect(res.code).toBe(0); // 未写 403
  });

  it('B2 复现根因：接收方密钥B、发送方用密钥A签名 → 403 局域网签名校验失败', () => {
    process.env.LAN_SECRET = 'keyB-receiver';
    const req: any = {
      headers: signedHeaders('keyA-sender-DIFFERENT', 'engine-A'),
      method: 'POST', path: PATH, body: BODY,
    };
    const res = fakeRes();
    const from = verifyLanRequest(req, res);
    expect(from).toBeNull();
    expect(res.code).toBe(403);
    expect(res.body.error).toBe('局域网签名校验失败');
  });

  it('B3 双方手动设置同一共享密钥 → 验签通过', () => {
    process.env.LAN_SECRET = 'same-shared-key';
    const req: any = {
      headers: signedHeaders('same-shared-key', 'engine-A'),
      method: 'POST', path: PATH, body: BODY,
    };
    const res = fakeRes();
    const from = verifyLanRequest(req, res);
    expect(from).toBe('engine-A');
    expect(res.code).toBe(0);
  });

  it('B4 缺协议标识头 → 403 非灵犀局域网协议请求', () => {
    delete process.env.LAN_SECRET;
    const req: any = {
      headers: { 'x-lingxi-from': 'engine-A' }, // 无 proto
      method: 'POST', path: PATH, body: BODY,
    };
    const res = fakeRes();
    const from = verifyLanRequest(req, res);
    expect(from).toBeNull();
    expect(res.code).toBe(403);
    expect(res.body.error).toBe('非灵犀局域网协议请求');
  });
});
