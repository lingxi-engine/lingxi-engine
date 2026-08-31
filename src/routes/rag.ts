/**
 * RAG 路由 — 知识库管理
 */
import { Router } from 'express';
import { readdirSync, statSync, readFileSync } from 'fs';
import * as path from 'path';
import { jwtAuth } from '../middleware/jwt-auth.js';
import type { ServerContext } from '../server/context.js';

export function createRagRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { router: msgRouter } = ctx;
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;

  // 初始化 RAG
  msgRouter.initRAG();

  // 上传/添加文档
  router.post('/rag/documents', requireAuth, async (req, res) => {
    try {
      const { title, source, mimeType, content, metadata } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'title 和 content 必填' });
      const doc = {
        id: 'rag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        title,
        source: source || title,
        mimeType: mimeType || 'text/plain',
        content,
        createdAt: Date.now(),
        metadata: metadata || {},
      };
      const chunkCount = await msgRouter.addRagDocument(doc);
      res.json({ ok: true, docId: doc.id, chunkCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 列出文档
  router.get('/rag/documents', requireAuth, (_req, res) => {
    try {
      const docs = msgRouter.listRagDocuments();
      res.json({ ok: true, count: docs.length, documents: docs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除文档
  router.delete('/rag/documents/:id', requireAuth, (req, res) => {
    try {
      const removed = msgRouter.removeRagDocument(String(req.params.id));
      if (!removed) return res.status(404).json({ error: '文档不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 知识库检索
  router.get('/rag/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const topK = parseInt(req.query.topK as string) || 5;
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      const hits = await msgRouter.searchRag(q, topK);
      res.json({ ok: true, query: q, hits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // RAG 生成
  router.post('/rag/generate', requireAuth, async (req, res) => {
    try {
      const { query, topK, systemPrompt } = req.body;
      if (!query) return res.status(400).json({ error: 'query 必填' });
      const result = await msgRouter.ragGenerate(query, { topK, systemPrompt });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // 扫描工作区文档并自动导入知识库（批次13b 自 index.ts 内联块移植）
  router.post('/rag/scan-workspace', requireAuth, async (_req, res) => {
    try {
      const wsRoot = (globalThis as any).__workspaceRoot || process.cwd();
      const SUPPORTED_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
      const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'storage', 'uploads', 'dist', 'build', 'coverage', '.next', '.nuxt', 'avatars']);
      const existing = new Set((msgRouter.listRagDocuments() || []).map((d: any) => d.title));
      const files: string[] = [];
      const walk = (dir: string) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) walk(full);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (SUPPORTED_EXT.has(ext)) files.push(full);
          }
        }
      };
      walk(wsRoot);
      let imported = 0, skipped = 0;
      for (const full of files) {
        try {
          const name = full.split(/[\\/]/).pop() || full;
          if (existing.has(name)) { skipped++; continue; }
          const stat = statSync(full);
          if (stat.size > 2 * 1024 * 1024) { skipped++; continue; }
          const content = readFileSync(full, 'utf8');
          if (!content.trim()) { skipped++; continue; }
          const ext = path.extname(name).toLowerCase();
          const doc = {
            id: 'rag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            title: name,
            source: full,
            mimeType: (ext === '.md' || ext === '.markdown') ? 'text/markdown' : 'text/plain',
            content,
            createdAt: Date.now(),
            metadata: { path: full },
          };
          await msgRouter.addRagDocument(doc);
          imported++;
          existing.add(name);
        } catch { skipped++; }
      }
      res.json({ ok: true, imported, skipped });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}