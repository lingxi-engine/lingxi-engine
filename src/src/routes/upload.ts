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
  // v2.0.7 安全修复：扩展名白名单，防止上传 .html/.svg 等 XSS 载荷
  const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
    '.json', '.xml', '.yaml', '.yml']);
  const upload = multer({
    storage, limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      if (!allowedExts.has(ext)) return cb(new Error('不支持的文件类型: ' + ext));
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