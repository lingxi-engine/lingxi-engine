/**
 * 个人中心路由 — 获取/更新用户资料（头像、介绍、昵称）
 */
import { Router } from 'express';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import type { ServerContext } from '../server/context.js';

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
      const userId = req.query.userId as string;
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      const user = db.getUser(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      // 查询积分
      let credits = 0;
      try {
        const creditsRow = db.raw.prepare('SELECT credits FROM user_credits WHERE user_id = ?').bind([userId]);
        if (creditsRow.step()) { credits = creditsRow.get()[0] || 0; }
        creditsRow.free();
      } catch {}

      // 查询评分
      let avgRating = 0;
      let ratingCount = 0;
      try {
        const ratingRow = db.raw.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM message_ratings WHERE user_id = ?').bind([userId]);
        if (ratingRow.step()) { const r = ratingRow.getAsObject(); avgRating = r.avg || 0; ratingCount = r.cnt || 0; }
        ratingRow.free();
      } catch {}

      // 查询用量
      let totalTokens = 0;
      let calls = 0;
      try {
        const usageRow = db.raw.prepare('SELECT SUM(tokens) as tokens, COUNT(*) as calls FROM messages WHERE sender_id = ?').bind([userId]);
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
      const { userId, displayName, bio, avatarUrl } = req.body;
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // P1 修复: 只能修改自己的资料（管理员除外）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isAdmin && userId !== jwtSub && userId !== jwtNumericId) {
        return res.status(403).json({ error: '无权修改他人资料' });
      }

      const user = db.getUser(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      const sets: string[] = [];
      const vals: any[] = [];

      if (displayName !== undefined) {
        sets.push('display_name = ?');
        vals.push(displayName.trim());
      }
      if (bio !== undefined) {
        sets.push('bio = ?');
        vals.push(bio.trim());
      }
      if (avatarUrl !== undefined) {
        sets.push('avatar_url = ?');
        vals.push(avatarUrl);
      }

      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });

      vals.push(userId);
      db.raw.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);

      const updated = db.getUser(userId);
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
      const userId = req.body?.userId || req.query.userId as string;
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // P1 修复: 只能修改自己的头像（管理员除外）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isAdmin && userId !== jwtSub && userId !== jwtNumericId) {
        return res.status(403).json({ error: '无权修改他人头像' });
      }

      const user = db.getUser(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      if (!req.file) return res.status(400).json({ error: '请上传图片文件' });

      const avatarUrl = `/avatars/${req.file.filename}`;

      // 更新数据库
      db.raw.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, userId]);

      res.json({ ok: true, avatarUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
