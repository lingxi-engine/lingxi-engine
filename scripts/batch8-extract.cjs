#!/usr/bin/env node
/**
 * 批次 8 切除脚本 v2 — custom-providers 块 (L1760-1800) → src/routes/custom-providers.ts
 * 带硬断言: 标记定位 / 块长度 / 6 条路由精确比对 / 依赖计数 / 关键调用 / 残留检查
 * 任一断言失败 → 零写入退出
 */
const fs = require('fs');

const t = fs.readFileSync('index.ts', 'utf8');
const lines = t.split('\r\n');
if (lines.length < 2000) throw new Error('line count sanity fail: ' + lines.length);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countOf = (s) => (t.match(new RegExp(esc(s), 'g')) || []).length;

// ── 1. 标记定位 ──
const START = 'V5 P6: 自定义 Provider API';
const END = 'V5 P7: 开发者模式 API';
if (countOf(START) !== 1) throw new Error('start marker not unique: ' + countOf(START));
if (countOf(END) !== 2) throw new Error('end marker count != 2: ' + countOf(END)); // L1802 真边界 + L1858 重复注释
const iStart = lines.findIndex(l => l.includes(START));
const iEnd = lines.findIndex(l => l.includes(END)); // 取首次出现 = L1802 真边界
if (iStart < 0 || iEnd <= iStart) throw new Error(`markers wrong: start=${iStart} end=${iEnd}`);

// ── 2. 块结构断言 ──
const block = lines.slice(iStart, iEnd); // 含 P6 标记行，不含 P7 标记行
if (block.length !== 42) throw new Error('block length != 42: ' + block.length);
const bj = block.join('\n');

// ── 3. 路由精确比对（6 条，排序后逐项相等）──
const routeRe = /app\.(get|post|delete)\(\s*'([^']+)'/g;
const paths = [...bj.matchAll(routeRe)].map(m => m[1].toUpperCase() + ' ' + m[2]).sort();
const expected = [
  'DELETE /api/custom-providers/:id',
  'GET /api/custom-providers',
  'GET /api/custom-providers/backends',
  'POST /api/custom-providers',
  'POST /api/custom-providers/:id/detect',
  'POST /api/custom-providers/test',
].sort();
if (JSON.stringify(paths) !== JSON.stringify(expected)) {
  throw new Error('route mismatch:\n got: ' + JSON.stringify(paths) + '\n exp: ' + JSON.stringify(expected));
}

// ── 4. 依赖符号计数 ──
const cnt = (re) => (bj.match(re) || []).length;
if (cnt(/customProviderManager\./g) !== 6) throw new Error('customProviderManager refs != 6: ' + cnt(/customProviderManager\./g));
if (cnt(/INFERENCE_BACKENDS/g) !== 1) throw new Error('INFERENCE_BACKENDS refs != 1: ' + cnt(/INFERENCE_BACKENDS/g));
if (cnt(/requireAuth/g) !== 6) throw new Error('requireAuth refs != 6: ' + cnt(/requireAuth/g));
if (!bj.includes('testConnection') || !bj.includes('detectModels')) throw new Error('missing key calls');

// ── 5. 组装新文件（删除块 + 加 import + 加挂载）──
const newLines = [...lines.slice(0, iStart), ...lines.slice(iEnd)];
const t2 = newLines.join('\r\n');
const impAnchor = "import { registerSubAgentRoutes } from './src/routes/subagents.js';";
if ((t2.match(new RegExp(esc(impAnchor), 'g')) || []).length !== 1) throw new Error('import anchor not unique');
const newImp = "import { registerCustomProviderRoutes } from './src/routes/custom-providers.js';";
const t3 = t2.replace(impAnchor, impAnchor + '\r\n' + newImp);
const mAnchor = '  registerWalletRoutes(app, { optAuth, requireAuth });';
if ((t3.match(new RegExp(esc(mAnchor), 'g')) || []).length !== 1) throw new Error('mount anchor not unique');
const newMount = '  registerCustomProviderRoutes(app, { INFERENCE_BACKENDS, customProviderManager, requireAuth });';
const t4 = t3.replace(mAnchor, mAnchor + '\r\n' + newMount);

// ── 6. 残留检查 ──
if (t4.includes('/api/custom-providers')) throw new Error('custom-providers residue remains in index.ts');
if (!t4.includes(newImp)) throw new Error('import not injected');
if (!t4.includes(newMount)) throw new Error('mount not injected');

// ── 7. 落盘 ──
fs.writeFileSync('index.ts', t4, 'utf8');
console.log('OK batch8 excised: removed 0-based lines', iStart, '..', iEnd - 1, '| block=42 lines | new total:', newLines.length, '| import+mount injected');