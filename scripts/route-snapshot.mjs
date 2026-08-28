#!/usr/bin/env node
/**
 * 路由快照工具 — 巨石拆分安全网
 * 用法:
 *   node scripts/route-snapshot.mjs save    # 抓取当前路由快照存为基线
 *   node scripts/route-snapshot.mjs check   # 抓取当前路由并与基线比对，不一致则退出码 1
 * 提取规则: 静态正则匹配 app.METHOD('path' 形式（与迁移前后一致的提取口径）
 * 扫描范围: index.ts + src/routes 下已挂载的迁移文件（TARGETS 列表，随批次推进追加）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  join(ROOT, 'index.ts'),
  join(ROOT, 'src', 'routes', 'auth-main.ts'),
  join(ROOT, 'src', 'routes', 'friends-chats.ts'),
  join(ROOT, 'src', 'routes', 'workflows.ts'),
  join(ROOT, 'src', 'routes', 'wallet.ts'),
  join(ROOT, 'src', 'routes', 'market.ts'),
  join(ROOT, 'src', 'routes', 'agents.ts'),
  // 迁移批次推进时在此追加: join(ROOT, 'src', 'routes', 'xxx.ts'),
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

const cmd = process.argv[2] || 'check';
const routes = extractRoutes();
console.log(`[route-snapshot] 扫描 ${TARGETS.length} 个文件, 提取到 ${routes.length} 条独立路由`);

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