// 批次13b补丁：RAG 内联块抽换
// Part1: rag.ts —— 补 jwtAuth/fs/path 导入 + requireAuth 定义 + 5条既有路由补锁 + 移植 scan-workspace
// Part2: index.ts —— 删 L846-957 内联块(112行) + 加 import + 挂载 createRagRoutes
import fs from 'fs';

// ═══ Part 1: rag.ts ═══
let rag = fs.readFileSync('src/routes/rag.ts', 'utf8');

// 前置断言
const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败: ' + msg); process.exit(1); } };
assert(!rag.includes('jwtAuth'), 'rag.ts 已含 jwtAuth? 不应发生');
assert(!rag.includes('requireAuth'), 'rag.ts 已含 requireAuth? 不应发生');
assert(!rag.includes('scan-workspace'), 'rag.ts 已含 scan-workspace? 不应发生');
assert((rag.match(/return router;/g) || []).length === 1, 'return router; 不唯一');
assert((rag.match(/const \{ router: msgRouter \} = ctx;/g) || []).length === 1, 'msgRouter 解构不唯一');

// 1a. 导入区
rag = rag.replace(
  `import { Router } from 'express';
import type { ServerContext } from '../server/context.js';`,
  `import { Router } from 'express';
import { readdirSync, statSync, readFileSync } from 'fs';
import * as path from 'path';
import { jwtAuth } from '../middleware/jwt-auth.js';
import type { ServerContext } from '../server/context.js';`
);

// 1b. requireAuth 定义
rag = rag.replace(
  `  const { router: msgRouter } = ctx;`,
  `  const { router: msgRouter } = ctx;
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;`
);

// 1c. 5 条既有路由补锁
rag = rag.replace(`router.post('/rag/documents', async`, `router.post('/rag/documents', requireAuth, async`);
rag = rag.replace(`router.get('/rag/documents', (_req`, `router.get('/rag/documents', requireAuth, (_req`);
rag = rag.replace(`router.delete('/rag/documents/:id', (req`, `router.delete('/rag/documents/:id', requireAuth, (req`);
rag = rag.replace(`router.get('/rag/search', async`, `router.get('/rag/search', requireAuth, async`);
rag = rag.replace(`router.post('/rag/generate', async`, `router.post('/rag/generate', requireAuth, async`);

// 1d. 移植 scan-workspace（自 index.ts L909-957，router→msgRouter，join→path.join）
const scanRoute = `
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
          const name = full.split(/[\\\\/]/).pop() || full;
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

  return router;`;
rag = rag.replace(`  return router;`, scanRoute);

// Part1 后置自检
const ragAuthCount = (rag.match(/requireAuth/g) || []).length;
assert(ragAuthCount === 7, 'rag.ts requireAuth 计数=' + ragAuthCount + '，期望 7（1定义+6路由）');
assert(rag.includes("router.post('/rag/scan-workspace'"), 'scan-workspace 路由未落');
fs.writeFileSync('src/routes/rag.ts', rag);
console.log('✅ Part1 rag.ts: requireAuth×7, scan-workspace 已移植');

// ═══ Part 2: index.ts ═══
let idx = fs.readFileSync('index.ts', 'utf8');
const lines = idx.split('\n');

// 前置断言（内容锚点，不信任行号）
assert((idx.match(/── RAG 知识库初始化 ──/g) || []).length === 1, 'RAG 初始化注释不唯一');
assert((idx.match(/'\/api\/rag\//g) || []).length === 6, '内联 /api/rag/ 路由数≠6');
assert(!idx.includes('createRagRoutes'), 'index.ts 已含 createRagRoutes? 不应发生');
assert((idx.match(/createSkillsRoutes\(\{ skillManager \} as any\)/g) || []).length === 1, 'skills 挂载行不唯一');
// 行锚点复核
assert(lines[845].includes('RAG 知识库初始化'), 'L846 内容不符: ' + lines[845]);
assert(lines[956].trim() === '});', 'L957 内容不符: ' + lines[956]);
assert(lines[959].includes('工具列表 API'), 'L960 内容不符: ' + lines[959]);

// 2a. 删 L846-957（索引 845..956，共 112 行）
const removed = lines.splice(845, 112);
assert(removed[0].includes('RAG 知识库初始化'), '切除首行不符');
assert(removed[removed.length - 1].trim() === '});', '切除尾行不符');
idx = lines.join('\n');

// 2b. 后置断言：内联 rag 路由清零
assert(!idx.includes("'\/api\/rag\/"), '删除后仍有内联 /api/rag/ 残留');
assert(idx.includes('router.initRAG()') === false || (idx.match(/router\.initRAG\(\)/g) || []).length === 0, '内联 initRAG 残留');

// 2c. 加 import（紧跟 skills import 之后）
idx = idx.replace(
  `import { createSkillsRoutes } from './src/routes/skills.js';`,
  `import { createSkillsRoutes } from './src/routes/skills.js';
import { createRagRoutes } from './src/routes/rag.js';`
);

// 2d. 挂载（紧跟 skills 挂载之后）
idx = idx.replace(
  `  app.use('/api', createSkillsRoutes({ skillManager } as any));`,
  `  app.use('/api', createSkillsRoutes({ skillManager } as any));
  app.use('/api', createRagRoutes({ router } as any)); // REST 6条(模块版自带requireAuth, 含移植的scan-workspace)`
);

// Part2 后置自检
assert((idx.match(/createRagRoutes/g) || []).length === 2, 'createRagRoutes 引用数≠2(import+挂载)');
const outLines = idx.split('\n').length;
fs.writeFileSync('index.ts', idx);
console.log('✅ Part2 index.ts: 内联块已切除, import+挂载已加, 现存 ' + outLines + ' 行');
console.log('📦 批次13b 补丁完成');