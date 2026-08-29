/**
 * 文件上传路由
 */
import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import type { ServerContext } from '../server/context.js';

export function createUploadRoutes(ctx: ServerContext): Router {
  const router = Router();

  const uploadsDir = join(ctx.dataDir, 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) =>
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + extname(file.originalname)),
  });
  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      const name = String(file.originalname || '').toLowerCase();
      const blocked = /\.(exe|dll|bat|cmd|scr|sh|ps1|js|mjs|html?|svg|vbs|msi)$/;
      if (blocked.test(name)) return cb(new Error('禁止上传可执行/脚本类文件'));
      cb(null, true);
    },
  });

  router.post('/upload', upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const url = '/uploads/' + req.file.filename;
      res.json({ ok: true, url, originalName: req.file.originalname, size: req.file.size });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}