/**
 * 运行时冒烟 v2 — 全部 9 个挂载模块
 * 1) 静态: 逐文件提取路由, 检测跨模块重复路由(快照去重会掩盖的双注册bug)
 * 2) 动态: 真实 import 每个工厂函数, mock app 注册, 断言路由数与静态提取一致
 * 任一失败 → 非零退出
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 万能依赖代理: 可调用、可取任意属性, 注册期只解构不执行业务, 足够 ──
const ANY: any = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : ANY),
  apply: () => ANY,
  construct: () => ANY,
});

function mockApp() {
  const routes: string[] = [];
  const app: any = {};
  for (const mon of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
    app[mon] = (path: string, ..._h: any[]) => routes.push(`${mon.toUpperCase()} ${path}`);
  }
  app.use = (..._a: any[]) => { /* 中间件: 记录但不计入路由 */ };
  for (const mon of ['get', 'post', 'put', 'delete', 'patch', 'all']) {
  }
  return { app, routes };
}

const RE = /\bapp\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g;

// ── 第 1 步: 静态提取 + 跨模块重复检测 ──
const MODULE_FILES: Array<[string, string]> = [
  ['auth-main', 'src/routes/auth-main.ts'],
  ['friends-chats', 'src/routes/friends-chats.ts'],
  ['workflows', 'src/routes/workflows.ts'],
  ['wallet', 'src/routes/wallet.ts'],
  ['market', 'src/routes/market.ts'],
  ['agents', 'src/routes/agents.ts'],
  ['subagents', 'src/routes/subagents.ts'],
  ['custom-providers', 'src/routes/custom-providers.ts'],
  ['v1.7', 'src/routes-v1.7.ts'],
];

const origin = new Map<string, string[]>();
let staticSum = 0;
for (const [, f] of MODULE_FILES) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  const found = [...src.matchAll(RE)].map(m => `${m[1].toUpperCase()} ${m[2]}`);
  staticSum += found.length;
  for (const r of found) {
    if (!origin.has(r)) origin.set(r, []);
    origin.get(r)!.push(f);
  }
}
const dups = [...origin.entries()].filter(([, fs]) => new Set(fs).size > 1);
console.log(`[smoke] 静态提取: ${MODULE_FILES.length} 个模块文件共 ${staticSum} 条, 去重后 ${origin.size} 条`);
if (dups.length) {
  console.error('[smoke] ❌ 跨模块重复路由 (双注册隐患):');
  dups.forEach(([r, fs]) => console.error(`  ✗ ${r} → ${[...new Set(fs)].join(' + ')}`));
  process.exit(1);
}
console.log('[smoke] ✅ 无跨模块重复路由');

// ── 第 2 步: 动态 import + 注册, 断言与静态一致 ──
const passThrough = (_a: any, _b: any, next: any) => next();
const caseList: Array<[string, () => Promise<any>, Record<string, unknown>]> = [
  ['auth-main', () => import('../src/routes/auth-main.js'), { requireAuth: passThrough }],
  ['friends-chats', () => import('../src/routes/friends-chats.js'), { requireAuth: passThrough }],
  ['workflows', () => import('../src/routes/workflows.js'), { requireAuth: passThrough }],
  ['wallet', () => import('../src/routes/wallet.js'), { optAuth: passThrough, requireAuth: passThrough }],
  ['market', () => import('../src/routes/market.js'), { optAuth: passThrough, requireAuth: passThrough }],
  ['agents', () => import('../src/routes/agents.js'), { requireAuth: passThrough }],
  ['subagents', () => import('../src/routes/subagents.js'), { requireAuth: passThrough }],
  ['custom-providers', () => import('../src/routes/custom-providers.js'), { INFERENCE_BACKENDS: [], customProviderManager: ANY, requireAuth: passThrough }],
  ['v1.7', () => import('../src/routes-v1.7.js'), {}],
];

let fail = 0;
for (const [name, load, deps] of caseList) {
  try {
    const mod: any = await load();
    const keys = Object.keys(mod).filter(k => /^register\w*Routes$/.test(k));
    if (keys.length !== 1) throw new Error(`导出的 register*Routes 不唯一: ${keys.join(',') || '无'}`);
    const fn = mod[keys[0]];
    const { app, routes } = mockApp();
    fn(app, deps);
    const file = MODULE_FILES.find(([n]) => n === name)![1];
    const src = readFileSync(join(ROOT, file), 'utf8');
    const staticN = [...src.matchAll(RE)].length;
    const ok = routes.length === staticN && routes.length > 0;
    console.log(`[smoke] ${ok ? '✅' : '❌'} ${name.padEnd(16)} 动态注册 ${routes.length} 条 / 静态 ${staticN} 条 (factory: ${keys[0]})`);
    if (!ok) fail++;
  } catch (e: any) {
    console.error(`[smoke] ❌ ${name} 加载/注册失败: ${e.message}`);
    fail++;
  }
}

if (fail) {
  console.error(`[smoke] ❌ ${fail} 个模块未通过`);
  process.exit(1);
}
console.log('[smoke] ✅ 全部 9 个挂载模块运行时加载+注册通过');