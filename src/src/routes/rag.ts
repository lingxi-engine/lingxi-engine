/**
 * RAG 路由 — 知识库管理
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createRagRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { router: msgRouter } = ctx;

  // 初始化 RAG
  msgRouter.initRAG();

  // 上传/添加文档
  router.post('/rag/documents', async (req, res) => {
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
  router.get('/rag/documents', (_req, res) => {
    try {
      const docs = msgRouter.listRagDocuments();
      res.json({ ok: true, count: docs.length, documents: docs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除文档
  router.delete('/rag/documents/:id', (req, res) => {
    try {
      const removed = msgRouter.removeRagDocument(req.params.id);
      if (!removed) return res.status(404).json({ error: '文档不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 知识库检索
  router.get('/rag/search', async (req, res) => {
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
  router.post('/rag/generate', async (req, res) => {
    try {
      const { query, topK, systemPrompt } = req.body;
      if (!query) return res.status(400).json({ error: 'query 必填' });
      const result = await msgRouter.ragGenerate(query, { topK, systemPrompt });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}