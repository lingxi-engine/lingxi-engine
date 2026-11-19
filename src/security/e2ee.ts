/**
 * 端到端加密模块（E2EE）— 私聊/LAN 群消息/跨实例 peer 消息
 *
 * 方案（实用简化版 Signal 协议，零新依赖，Node >= 18 内置 crypto 即可）：
 *   - 每个实例一对 X25519 长期身份密钥（私钥落 e2ee_keys 表，永不外传）
 *   - 与 peer 的会话根密钥 = HKDF-SHA256( ECDH(我方私钥, 对方公钥) )
 *   - 每条消息独立派生密钥：msgKey = HKDF(rootKey, info=`lingxi-msg:${pairInfo}:${sendCounter}`)，
 *     发送计数器每条 +1（简化 ratchet，单向前向保密）
 *   - 消息体 AES-256-GCM 加密，密文格式：e2ee:v1:<b64 iv>:<b64 tag>:<b64 ct>:<counter>
 *   - 公钥交换走 peer 通道（LAN: /api/lan/peer/key-exchange；Mesh: peer.key 消息）
 *
 * S7 修复（2026-11-19）：HKDF info 必须双侧对称。
 *   旧版 info 拼 peerId——A 侧用对方实例 ID、B 侧用 A 的实例 ID，两侧派生出不同根密钥/消息密钥，
 *   AES-GCM 认证必失败 → 接收方落库「[加密消息：解密失败]」。此前活路由未接密钥交换、全走明文，
 *   缺陷被掩盖；S7 接通 onPeerSeen 密钥交换后暴露（双引擎 e2e 16/18 项失败实锤）。
 *   现改为「双方公钥排序拼接」作 info：两侧持有同一对公钥，info 必然一致，且无需引入 instanceId 依赖。
 *
 * 降级策略：对方公钥未知时 encryptForPeer 返回 null（调用方应回退明文并提示），
 * decryptFromPeer 遇到非 e2ee: 前缀原样返回（兼容历史明文）。
 */

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const PREFIX = 'e2ee:v1:';

// ── 身份密钥 ──────────────────────────────────────────────

let _identity: { publicKeyB64: string; privateKey: crypto.KeyObject } | null = null;

/** 生成或加载本实例 X25519 身份密钥（私钥持久化在 DB e2ee_keys 表） */
export function ensureIdentityKey(db: any): { publicKeyB64: string; privateKey: crypto.KeyObject } {
  if (_identity) return _identity;
  try {
    const stmt = db.prepare("SELECT public_key, private_key FROM e2ee_keys WHERE id = 'self'");
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      if (row && row.private_key) {
        _identity = {
          publicKeyB64: String(row.public_key),
          privateKey: crypto.createPrivateKey({ key: Buffer.from(String(row.private_key), 'base64'), format: 'der', type: 'pkcs8' }),
        };
        return _identity;
      }
    } else {
      stmt.free();
    }
  } catch { /* 表不存在等，走生成流程 */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  _identity = { publicKeyB64: pubB64, privateKey };
  try {
    db.run(
      "INSERT OR REPLACE INTO e2ee_keys (id, public_key, private_key, created_at) VALUES ('self', ?, ?, ?)",
      [pubB64, privB64, Date.now()]
    );
  } catch (e: any) { console.warn('[E2EE] 身份密钥持久化失败（仅内存）:', e.message); }
  return _identity;
}

export function getIdentityPublicKeyB64(db: any): string {
  return ensureIdentityKey(db).publicKeyB64;
}

// ── peer 公钥管理 ─────────────────────────────────────────

export function setPeerPublicKey(db: any, peerId: string, pubB64: string): void {
  try {
    db.run(
      "INSERT OR REPLACE INTO e2ee_keys (id, public_key, created_at) VALUES (?, ?, ?)",
      ['peer:' + peerId, pubB64, Date.now()]
    );
    _sessions.delete(peerId); // 换公钥后会话失效，清缓存
  } catch (e: any) { console.warn('[E2EE] 保存 peer 公钥失败:', e.message); }
}

export function getPeerPublicKey(db: any, peerId: string): string | null {
  try {
    const stmt = db.prepare("SELECT public_key FROM e2ee_keys WHERE id = ?");
    stmt.bind(['peer:' + peerId]);
    let val: string | null = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      val = row.public_key != null ? String(row.public_key) : null;
    }
    stmt.free();
    return val;
  } catch { return null; }
}

// ── 会话密钥（内存缓存） ──────────────────────────────────

// S7: 缓存根密钥 + 对称 info（双方公钥排序拼接），加密/解密共用同一份
const _sessions = new Map<string, { root: Buffer; pairInfo: string }>();
const _sendCounters = new Map<string, number>();

function deriveSession(db: any, peerId: string): { root: Buffer; pairInfo: string } | null {
  const cached = _sessions.get(peerId);
  if (cached) return cached;
  const pubB64 = getPeerPublicKey(db, peerId);
  if (!pubB64) return null;
  const id = ensureIdentityKey(db);
  try {
    const peerPub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: id.privateKey, publicKey: peerPub });
    // S7: info 双侧对称——双方公钥排序拼接。旧版拼 peerId 导致两侧根密钥不同，解密必失败。
    const pairInfo = [id.publicKeyB64, pubB64].sort().join('|');
    const root = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('lingxi-e2ee-root:' + pairInfo), 32) as unknown as Buffer);
    const sess = { root, pairInfo };
    _sessions.set(peerId, sess);
    return sess;
  } catch (e: any) {
    console.warn('[E2EE] 会话密钥派生失败:', e.message);
    return null;
  }
}

// ── 加解密 ────────────────────────────────────────────────

export function isE2EE(s: any): boolean {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

/** 加密给某 peer 的消息；无对方公钥时返回 null（调用方应回退明文） */
export function encryptForPeer(db: any, peerId: string, plaintext: string): string | null {
  if (!plaintext) return plaintext;
  if (isE2EE(plaintext)) return plaintext;
  const sess = deriveSession(db, peerId);
  if (!sess) return null;
  const counter = (_sendCounters.get(peerId) || 0) + 1;
  _sendCounters.set(peerId, counter);
  const msgKey = Buffer.from(crypto.hkdfSync('sha256', sess.root, Buffer.alloc(0), Buffer.from(`lingxi-msg:${sess.pairInfo}:${counter}`), 32) as unknown as Buffer);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, msgKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}:${counter}`;
}

/** 解密来自某 peer 的消息；非 e2ee 前缀原样返回（兼容明文） */
export function decryptFromPeer(db: any, peerId: string, ciphertext: string): string {
  if (!ciphertext || !isE2EE(ciphertext)) return ciphertext;
  const sess = deriveSession(db, peerId);
  if (!sess) {
    console.warn(`[E2EE] 无 peer ${peerId} 的会话密钥，无法解密`);
    return '[加密消息：缺少会话密钥]';
  }
  try {
    const parts = ciphertext.slice(PREFIX.length).split(':');
    const [ivB64, tagB64, dataB64, counterStr] = parts;
    const counter = parseInt(counterStr || '0', 10) || 0;
    const msgKey = Buffer.from(crypto.hkdfSync('sha256', sess.root, Buffer.alloc(0), Buffer.from(`lingxi-msg:${sess.pairInfo}:${counter}`), 32) as unknown as Buffer);
    const decipher = crypto.createDecipheriv(ALGO, msgKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e: any) {
    console.warn('[E2EE] 解密失败:', e.message);
    return '[加密消息：解密失败]';
  }
}

/** 状态（供 /api/health 暴露） */
export function e2eeStatus(db: any): { enabled: boolean; identityPublicKey: string; knownPeers: number } {
  try {
    const id = ensureIdentityKey(db);
    const r = db.exec("SELECT COUNT(*) AS c FROM e2ee_keys WHERE id LIKE 'peer:%'");
    const n = r[0] ? Number(r[0].values[0][0]) : 0;
    return { enabled: true, identityPublicKey: id.publicKeyB64.slice(0, 16) + '…', knownPeers: n };
  } catch {
    return { enabled: false, identityPublicKey: '', knownPeers: 0 };
  }
}
