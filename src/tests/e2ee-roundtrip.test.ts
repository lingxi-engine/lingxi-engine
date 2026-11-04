/**
 * E2EE 模块往返测试：两个"实例"互相交换公钥后加密/解密应还原明文，
 * 且密文带 e2ee:v1: 前缀、对端未知公钥时返回 null。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { initDB, getDB } from '../storage/db.js';
import {
  ensureIdentityKey, getIdentityPublicKeyB64, setPeerPublicKey, getPeerPublicKey,
  encryptForPeer, decryptFromPeer, isE2EE, e2eeStatus,
} from '../security/e2ee.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lingxi-e2ee-'));
  await initDB(join(dir, 'test.db'));
});

describe('E2EE X25519 + AES-256-GCM roundtrip', () => {
  it('peer public key persists in e2ee_keys table', () => {
    const db = getDB();
    const kpB = crypto.generateKeyPairSync('x25519');
    const pubBB64 = kpB.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    setPeerPublicKey(db, 'instance-B', pubBB64);
    expect(getPeerPublicKey(db, 'instance-B')).toBe(pubBB64);
  });

  it('self-loop encrypt/decrypt roundtrip restores plaintext', () => {
    const db = getDB();
    const pubA = getIdentityPublicKeyB64(db);
    setPeerPublicKey(db, 'self-loop', pubA);
    const plain = '你好，这是一条端到端加密的私聊消息 🔒';
    const enc = encryptForPeer(db, 'self-loop', plain);
    expect(enc).not.toBeNull();
    expect(isE2EE(enc)).toBe(true);
    expect(enc).not.toContain(plain);
    expect(decryptFromPeer(db, 'self-loop', enc!)).toBe(plain);
  });

  it('returns null when peer public key unknown', () => {
    const db = getDB();
    expect(encryptForPeer(db, 'nobody', 'hi')).toBeNull();
  });

  it('passes through plaintext on decrypt (backward compat)', () => {
    const db = getDB();
    expect(decryptFromPeer(db, 'x', '普通明文消息')).toBe('普通明文消息');
  });

  it('e2eeStatus reports enabled with identity key', () => {
    const st = e2eeStatus(getDB());
    expect(st.enabled).toBe(true);
    expect(st.identityPublicKey.length).toBeGreaterThan(0);
  });

  it('e2ee_keys table exists after migration', () => {
    const db = getDB();
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='e2ee_keys'");
    expect(r[0].values.length).toBe(1);
  });

  it('two distinct peers get different ciphertexts for same plaintext', () => {
    const db = getDB();
    const pubA = getIdentityPublicKeyB64(db);
    setPeerPublicKey(db, 'peer-1', pubA);
    const kp2 = crypto.generateKeyPairSync('x25519');
    setPeerPublicKey(db, 'peer-2', kp2.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
    const enc1 = encryptForPeer(db, 'peer-1', 'same text');
    const enc2 = encryptForPeer(db, 'peer-2', 'same text');
    expect(enc1).not.toBe(enc2);
  });
});
