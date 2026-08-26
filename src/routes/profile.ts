/**
 * 个人中心路由 — 获取/更新用户资料（头像、介绍、昵称）
 * 
 * [FIX 个人中心 2026-08] 修复"个人中心信息空白"问题：
 *  1. userId 可从 JWT 推断（sub / numeric_id），不传 query/body 也能用
 *  2. 查询走 db.getUser（已支持 id / numeric_id 双格式），查不到再按 numeric_id 兜底
 *  3. 云平台账号（ouid-N）首次编辑资料时自动在本地建档，避免 404
 *  4. UPDATE / 头像均按解析出的真实行 id 更新，消除"校验过了、更新不到"的错位
 */
import { Router } from 'express';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import type { ServerContext } from '../server/context.js';

/**
 * 解析 userId：query/body 优先，其次 JWT 的 sub，再其次 JWT 的 numeric_id
 */
function resolveUserId(req: any, bodyUserId?: string): string {
  const q = (req.query?.userId as string) || '';
  const b = bodyUserId || '';
  const jwt = req.user || {};
  const sub = String(jwt.sub || '');
  const nid = jwt.numeric_id !== undefined && jwt.numeric_id !== null ? String(jwt.numeric_id) : '';
  return q || b || sub || nid;
}

/**
 * 获取用户行：id / numeric_id 双格式兜底查询
 */
function findUser(db: any, userId: string): any {
  let user = db.getUser(userId);
  if (!user && !Number.isNaN(Number(userId))) {
    try { user = db.getUserByNumericId(Number(userId)); } catch {}
  }
  return user;
}

/**
 * 确保用户在本地存在：云平台账号（ouid-N）首次编辑资料时自动建档
 */
function ensureLocalUser(db: any, userId: string, jwtUser?: any): any {
  let user = findUser(db, userId);
  if (user) return user;
  const nidMatch = String(userId).match(/(\d+)$/);
  const numericId = nidMatch ? Number(nidMatch[1]) : (typeof db.nextNumericId === 'function' ? db.nextNumericId() : 0);
  const fallbackName = (jwtUser?.display_name || jwtUser?.displayName || '') || ('用户' + (numericId || Date.now() % 100000));
  try {
    db.createUser(userId, fallbackName);
    db.raw.run('UPDATE users SET numeric_id = ?, status = ?, updated_at = ? WHERE id = ?', [numericId, 'online', Date.now(), userId]);
    user = db.getUser(userId);
  } catch (e: any) {
    console.warn('[profile] auto-create user failed:', e.message);
  }
  return user;
}

export function createProfileRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db, dataDir } = ctx;

  // 头像上传 multer 配置
  const avatarDir = join(dataDir, 'avatars');
  if (!existsSync(avatarDir)) mkdirSync(avatarDir, { recursive: true });
  const avatarStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname || '.png') || '.png';
      cb(null, 'avatar-' + Date.now() + ext);
    },
  });
  const avatarUpload = multer({ 
  storage: avatarStorage, 
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片文件 (jpg/png/gif/webp/bmp)'));
    }
  },
});

  // ── 获取用户资料 ──
  router.get('/profile', (req, res) => {
    try {
      // [FIX] userId 可从 JWT 推断，不再强制要求 query 参数
      const userId = resolveUserId(req);
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      const user = findUser(db, userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      // 查询积分
      let credits = 0;
      try {
        const creditsRow = db.raw.prepare('SELECT credits FROM user_credits WHERE user_id = ?').bind([user.id]);
        if (creditsRow.step()) { credits = creditsRow.get()[0] || 0; }
        creditsRow.free();
      } catch {}

      // 查询评分
      let avgRating = 0;
      let ratingCount = 0;
      try {
        const ratingRow = db.raw.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM message_ratings WHERE user_id = ?').bind([user.id]);
        if (ratingRow.step()) { const r = ratingRow.getAsObject(); avgRating = r.avg || 0; ratingCount = r.cnt || 0; }
        ratingRow.free();
      } catch {}

      // 查询用量
      let totalTokens = 0;
      let calls = 0;
      try {
        const usageRow = db.raw.prepare('SELECT SUM(tokens) as tokens, COUNT(*) as calls FROM messages WHERE sender_id = ?').bind([user.id]);
        if (usageRow.step()) { const u = usageRow.getAsObject(); totalTokens = u.tokens || 0; calls = u.calls || 0; }
        usageRow.free();
      } catch {}

      res.json({
        ok: true,
        profile: {
          id: user.id,
          numeric_id: user.numeric_id,
          display_name: user.display_name || '',
          email: user.email || '',
          avatar_url: user.avatar_url || '',
          bio: user.bio || '',
          status: user.status || 'offline',
          created_at: user.created_at,
          email_verified: user.email_verified || 0,
        },
        credits,
        ratings: { avgRating, count: ratingCount },
        usage: { totalTokens, calls },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 更新用户资料 ──
  router.put('/profile', (req, res) => {
    try {
      const { userId: bodyUserId, displayName, bio, avatarUrl } = req.body;
      // [FIX] userId 可从 JWT 推断
      const userId = resolveUserId(req, bodyUserId);
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // P1 修复: 只能修改自己的资料（管理员除外）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isAdmin && userId !== jwtSub && userId !== jwtNumericId) {
        return res.status(403).json({ error: '无权修改他人资料' });
      }

      // [FIX] 双格式查询 + 云平台用户自动建档
      const user = ensureLocalUser(db, userId, jwtUser);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      const sets: string[] = [];
      const vals: any[] = [];

      if (displayName !== undefined) {
        sets.push('display_name = ?');
        vals.push(String(displayName).trim());
      }
      if (bio !== undefined) {
        sets.push('bio = ?');
        vals.push(String(bio).trim());
      }
      if (avatarUrl !== undefined) {
        sets.push('avatar_url = ?');
        vals.push(avatarUrl);
      }

      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });

      vals.push(user.id);  // [FIX] 按真实行 id 更新，不再依赖传入的 userId 格式
      db.raw.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);

      const updated = db.getUser(user.id);
      res.json({ ok: true, user: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 上传头像 ── Bug #2 修复: 加 multer 中间件 ──
  router.post('/profile/avatar', (req, res, next) => {
    avatarUpload.single('file')(req, res, (err) => {
      if (err) {
        if (err.message?.startsWith('只允许上传')) {
          return res.status(400).json({ error: err.message });
        }
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: '文件大小不能超过5MB' });
        }
        return res.status(400).json({ error: '上传失败: ' + err.message });
      }
      next();
    });
  }, (req, res) => {
    try {
      // [FIX] userId 可从 JWT 推断
      const userId = resolveUserId(req, req.body?.userId || req.query?.userId as string);
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // P1 修复: 只能修改自己的头像（管理员除外）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isAdmin && userId !== jwtSub && userId !== jwtNumericId) {
        return res.status(403).json({ error: '无权修改他人头像' });
      }

      // [FIX] 双格式查询 + 云平台用户自动建档
      const user = ensureLocalUser(db, userId, jwtUser);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      if (!req.file) return res.status(400).json({ error: '请上传图片文件' });

      const avatarUrl = `/avatars/${req.file.filename}`;

      // [FIX] 按真实行 id 更新
      db.raw.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, user.id]);

      res.json({ ok: true, avatarUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
