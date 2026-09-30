/**
 * 个人中心路由 — 获取/更新用户资料（头像、介绍、昵称）
 *
 * v3（平台统一版）修复：
 * 1. userId 不再死磕 query/body —— 可从 JWT(sub/numeric_id) 推断，本地 admin-auto 模式有兜底
 * 2. 查询/更新全部走「真实行 id」：双格式(findUser: id / numeric_id)解析，杜绝"校验过了、更新却找不到人"
 * 3. 云平台账号(ouid-N)自动建档：首次访问时用携带的 token 回云平台拉资料写入本地 users 表，
 *    之后个人中心、编辑资料、头像都能正常工作（不再 404「用户不存在」）
 * 4. 返回字段同时给下划线 + 驼峰两份，兼容新旧前端
 */
import { Router } from 'express';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import type { ServerContext } from '../server/context.js';

// 云平台地址（与前端 PLATFORM_URL、auth/platform-bind.ts 保持一致，可用环境变量覆盖）
const PLATFORM_URL = process.env.PLATFORM_URL || '';

/** 判断是否云平台账号 id（ouid-N 格式） */
export function isPlatformUserId(userId: string): boolean {
  return /^ouid-\d+$/.test(String(userId || ''));
}

/**
 * 云平台账号本地建档：本地查不到 + id 是 ouid-N → 用当前请求的 token 回云平台拉资料。
 * 拉取成功则写入本地 users 表（id=ouid-N, numeric_id=N, display_name/email/avatar_url/bio），返回建档后的用户。
 * 拉取失败/非云平台账号 → 返回 null。
 */
export async function ensurePlatformUser(
  db: any,
  userId: string,
  token?: string
): Promise<any | null> {
  if (!isPlatformUserId(userId)) return null;
  const localUser = db.getUser(userId);
  if (localUser) return localUser;
  if (!token) return null;

  try {
    const res = await fetch(PLATFORM_URL + '/api/user/me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const d = await res.json();
    const u = d?.user || d;
    if (!u || !u.id) return null;

    const nid = Number(u.numericId ?? u.numeric_id ?? userId.replace('ouid-', ''));
    const dn = String(u.displayName ?? u.display_name ?? '用户' + nid);
    const em = String(u.email || '');
    const av = String(u.avatarUrl ?? u.avatar_url ?? '');

    // 建档（密码为空字符串，仅作资料镜像；本地登录不受影响）
    try {
      db.raw.run(
        `INSERT OR IGNORE INTO users (id, numeric_id, email, display_name, avatar_url, bio, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
        [userId, nid, em || null, dn, av, String(u.bio || ''), Date.now(), Date.now()]
      );
    } catch (e: any) {
      console.warn('[Profile] 云平台用户建档失败:', e.message);
    }
    return db.getUser(userId);
  } catch (e: any) {
    console.warn('[Profile] 云平台资料拉取失败:', e.message);
    return null;
  }
}

/**
 * 解析目标用户 id：query/body 显式 userId → JWT sub → JWT numeric_id。
 * 返回 null 时调用方应回 400。
 */
function resolveUserId(req: any, body: any): string | null {
  const fromBody = body?.userId || body?.numeric_id;
  if (fromBody) return String(fromBody);
  const fromQuery = req.query?.userId || req.query?.numericId;
  if (fromQuery) return String(fromQuery);
  const jwtUser = req.user;
  if (jwtUser?.sub) return String(jwtUser.sub);
  if (jwtUser?.numeric_id != null) return String(jwtUser.numeric_id);
  return null;
}

/** 双格式查找 + 云平台建档兜底，返回真实用户行（含真实主键 id） */
async function findUser(db: any, userId: string, token?: string): Promise<any | null> {
  if (!userId) return null;
  let user = db.getUser(userId);
  if (user) return user;
  // 云平台账号：本地没有 → 尝试建档
  user = await ensurePlatformUser(db, userId, token);
  if (user) return user;
  return null;
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
      cb(null, 'avatar-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + ext);
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

  /** 取请求里的 Bearer token（云平台回查用） */
  function bearerToken(req: any): string | undefined {
    const h = req.headers?.authorization;
    return h && h.startsWith('Bearer ') ? h.slice(7) : undefined;
  }

  // ── 获取用户资料 ──
  router.get('/profile', async (req, res) => {
    try {
      const userId = resolveUserId(req, {});
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      const user = await findUser(db, userId, bearerToken(req));
      if (!user) return res.status(404).json({ error: '用户不存在' });


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
          numeric_id: user.numeric_id ?? null,
          display_name: user.display_name || '',
          email: user.email || '',
          avatar_url: user.avatar_url || '',
          bio: user.bio || '',
          status: user.status || 'offline',
          created_at: user.created_at,
          email_verified: user.email_verified || 0,
          // 驼峰兼容（新前端/云平台风格）
          numericId: user.numeric_id ?? null,
          displayName: user.display_name || '',
          avatarUrl: user.avatar_url || '',
        },
        ratings: { avgRating, count: ratingCount },
        usage: { totalTokens, calls },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 更新用户资料 ──
  router.put('/profile', async (req, res) => {
    try {
      const body = req.body || {};
      const userId = resolveUserId(req, body);
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // 权限：只能修改自己的资料（管理员除外）—— 支持 sub / numeric_id / ouid 全格式比对
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id ?? '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      const allowed =
        isAdmin ||
        userId === jwtSub ||
        userId === jwtNumericId ||
        userId === String(jwtNumericId) ||
        (isPlatformUserId(userId) && userId === jwtSub);
      if (!allowed) {
        return res.status(403).json({ error: '无权修改他人资料' });
      }

      const user = await findUser(db, userId, bearerToken(req));
      if (!user) return res.status(404).json({ error: '用户不存在' });

      // 兼容驼峰/下划线字段名
      const displayName = body.displayName ?? body.display_name;
      const bio = body.bio;
      const avatarUrl = body.avatarUrl ?? body.avatar_url;

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
        vals.push(String(avatarUrl));
      }

      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });

      // 关键：按真实行主键 id 更新（user.id 是解析后的真实主键，不再是外部传入的 userId）
      vals.push(user.id);
      db.raw.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);

      const updated = db.getUser(user.id);
      res.json({ ok: true, user: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 上传头像 ──
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
  }, async (req, res) => {
    try {
      const body = req.body || {};
      const userId = resolveUserId(req, body);
      if (!userId) return res.status(400).json({ error: '缺少 userId' });

      // 权限校验（同上）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id ?? '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      const allowed =
        isAdmin ||
        userId === jwtSub ||
        userId === jwtNumericId ||
        userId === String(jwtNumericId) ||
        (isPlatformUserId(userId) && userId === jwtSub);
      if (!allowed) {
        return res.status(403).json({ error: '无权修改他人头像' });
      }

      const user = await findUser(db, userId, bearerToken(req));
      if (!user) return res.status(404).json({ error: '用户不存在' });

      if (!req.file) return res.status(400).json({ error: '请上传图片文件' });

      const avatarUrl = `/avatars/${req.file.filename}`;

      // 更新数据库（按真实主键）
      db.raw.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, user.id]);

      res.json({ ok: true, avatarUrl });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
