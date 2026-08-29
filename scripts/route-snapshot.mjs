#!/usr/bin/env node
/**
 * 路由快照工具 — 巨石拆分安全网
 * 用法:
 *   node scripts/route-snapshot.mjs save    # 抓取当前路由快照存为基线
 *   node scripts/route-snapshot.mjs check   # 抓取当前路由并与基线比对，不一致则退出码 1
 * 提取规则: 静态正则匹配 app.METHOD('path' 形式（与迁移前后一致的提取口径）
 * 扫描范围: index.ts + src/routes 下已挂载的迁移文件（TARGETS 列表，随批次推进追加）
 *
 * v2 新增: 挂载完整性校验 —— 每个迁移模块在 index.ts 中必须同时满足:
 *   1) 存在 import { registerXxxRoutes } from '...'
 *   2) 存在 registerXxxRoutes( 的调用，且调用次数 === import 次数
 * 防止"只 import 不调用"的死路由（批次4 wallet 事故）再次漏网。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'index.ts');
const TARGETS = [
  join(ROOT, 'index.ts'),
  join(ROOT, 'src', 'routes', 'auth-main.ts'),
  join(ROOT, 'src', 'routes', 'friends-chats.ts'),
  join(ROOT, 'src', 'routes', 'workflows.ts'),
  join(ROOT, 'src', 'routes', 'wallet.ts'),
  join(ROOT, 'src', 'routes', 'market.ts'),
  join(ROOT, 'src', 'routes', 'agents.ts'),
  join(ROOT, 'src', 'routes', 'subagents.ts'),
  // 迁移批次推进时在此追加: join(ROOT, 'src', 'routes', 'xxx.ts'),
];
// 挂载校验清单: [工厂函数名, 模块路径] —— 函数名必须与 index.ts 实际 import 一致
const MOUNTS = [
  ['registerAuthRoutes', './src/routes/auth-main.js'],
  ['registerFriendsChatsRoutes', './src/routes/friends-chats.js'],
  ['registerWorkflowsRoutes', './src/routes/workflows.js'],
  ['registerWalletRoutes', './src/routes/wallet.js'],
  ['registerMarketRoutes', './src/routes/market.js'],
  ['registerAgentsRoutes', './src/routes/agents.js'],
  ['registerSubAgentRoutes', './src/routes/subagents.js'],
  ['registerV17Routes', './src/routes-v1.7.js'],
  // 迁移批次推进时在此追加
];
const BASELINE = join(ROOT, 'tests', 'baseline', 'routes-baseline.json');

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'];

function extractRoutes() {
  const routesAll = [];
  for (const TARGET of TARGETS) {
    const src = readFileSync(TARGET, 'utf8');
    const re = new RegExp("\\bapp\\.(" + METHODS.join('|') + ")\\(\\s*['\"`]([^'\"`]+)['\"`]", 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      routesAll.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  // 去重 + 排序，保证比对稳定性
  return [...new Set(routesAll)].sort();
}

/** 挂载完整性校验: import 有、调用有、次数相等。返回错误数组（空 = 通过） */
function checkMounts(indexSrc) {
  const errors = [];
  for (const [factory, modulePath] of MOUNTS) {
    const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${factory}\\b[^}]*\\}\\s*from\\s*['"\`]${escapedPath}['"\`]`, 'g');
    const callRe = new RegExp(`\\b${factory}\\s*\\(`, 'g');
    const imports = (indexSrc.match(importRe) || []).length;
    const calls = (indexSrc.match(callRe) || []).length;
    if (imports === 0 && calls === 0) {
      errors.push(`  ✗ ${factory}: 既无 import 也无调用 (模块 ${modulePath} 完全未接线)`);
    } else if (imports === 0) {
      errors.push(`  ✗ ${factory}: 有 ${calls} 处调用但无 import (tsc 应该会报错，但这里先拦)`);
    } else if (calls === 0) {
      errors.push(`  ✗ ${factory}: import 了但 0 次调用 —— 死路由! (批次4 wallet 事故模式)`);
    } else if (calls !== imports) {
      errors.push(`  ✗ ${factory}: import ${imports} 次 vs 调用 ${calls} 次，数量不匹配`);
    }
  }
  return errors;
}

const cmd = process.argv[2] || 'check';
const indexSrc = readFileSync(INDEX, 'utf8');
const routes = extractRoutes();
console.log(`[route-snapshot] 扫描 ${TARGETS.length} 个文件, 提取到 ${routes.length} 条独立路由`);

// 挂载完整性校验（save/check 两种模式都跑，结构性问题与基线无关）
const mountErrors = checkMounts(indexSrc);
if (mountErrors.length) {
  console.error(`[route-snapshot] ❌ 挂载完整性校验失败 (${mountErrors.length} 处):`);
  mountErrors.forEach(e => console.error(e));
  process.exit(3);
}
console.log(`[route-snapshot] ✅ 挂载完整性: ${MOUNTS.length}/${MOUNTS.length} 个模块 import+调用全部接通`);

if (cmd === 'save') {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ generatedAt: new Date().toISOString(), count: routes.length, routes }, null, 2));
  console.log(`[route-snapshot] 基线已保存: ${BASELINE}`);
  process.exit(0);
}

// check 模式
if (!existsSync(BASELINE)) {
  console.error('[route-snapshot] 基线不存在，先执行: node scripts/route-snapshot.mjs save');
  process.exit(2);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const baseSet = new Set(base.routes);
const nowSet = new Set(routes);
const lost = base.routes.filter(r => !nowSet.has(r));
const added = routes.filter(r => !baseSet.has(r));
if (lost.length || added.length) {
  console.error(`[route-snapshot] ❌ 路由漂移! 丢失 ${lost.length} 条, 新增 ${added.length} 条`);
  lost.forEach(r => console.error(`  - LOST: ${r}`));
  added.forEach(r => console.error(`  + NEW : ${r}`));
  process.exit(1);
}
console.log(`[route-snapshot] ✅ 与基线完全一致 (${base.count} 条)`);