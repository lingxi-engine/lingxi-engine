/**
 * 运行时冒烟: 验证迁移模块可加载、可注册（不启动完整服务器）
 * 覆盖: 批次4 wallet（本次修复的雷）+ 批次8 custom-providers（本次新迁出）
 */
import { registerWalletRoutes } from '../src/routes/wallet.js';
import { registerCustomProviderRoutes } from '../src/routes/custom-providers.js';

function mockApp() {
  const routes: string[] = [];
  const app: any = {};
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
    app[m] = (path: string, ...handlers: any[]) => routes.push(`${m.toUpperCase()} ${path}`);
  }
  return { app, routes };
}
const passThrough = (_a: any, _b: any, next: any) => next();

const a = mockApp();
registerWalletRoutes(a.app, { optAuth: passThrough, requireAuth: passThrough } as any);
console.log('[smoke] wallet 路由数:', a.routes.length);
if (a.routes.length !== 11) throw new Error('wallet routes != 11: ' + a.routes.length);
if (!a.routes.includes('GET /api/credits/balance')) throw new Error('wallet 缺关键路由 credits/balance');

const b = mockApp();
registerCustomProviderRoutes(b.app, {
  INFERENCE_BACKENDS: [{ id: 'openai' }],
  customProviderManager: {} as any,
  requireAuth: passThrough,
} as any);
console.log('[smoke] custom-providers 路由数:', b.routes.length);
if (b.routes.length !== 6) throw new Error('custom-providers routes != 6: ' + b.routes.length);
const expected = [
  'GET /api/custom-providers/backends',
  'GET /api/custom-providers',
  'POST /api/custom-providers',
  'DELETE /api/custom-providers/:id',
  'POST /api/custom-providers/test',
  'POST /api/custom-providers/:id/detect',
].sort();
if (JSON.stringify([...b.routes].sort()) !== JSON.stringify(expected)) {
  throw new Error('cp routes mismatch: ' + b.routes.join(' | '));
}
console.log('[smoke] ✅ 两模块运行时注册全部通过: wallet=11, custom-providers=6');