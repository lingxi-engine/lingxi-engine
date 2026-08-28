// platform-bind.ts 补丁：URL优先 PLATFORM_API_URL + 新协议(/api/auth/*)404回退旧协议 + payload对齐V7
import { readFileSync, writeFileSync, copyFileSync } from 'fs';

const F = 'src/auth/platform-bind.ts';
const src = readFileSync(F, 'utf8');
copyFileSync(F, F + '.bak-platform-20260827-014948');

let s = src;
const applied = [];

// ============ 1. URL 优先 PLATFORM_API_URL ============
s = s.replace(
  `const PLATFORM_URL = process.env.PLATFORM_URL || 'http://47.93.157.83:8080';`,
  `const PLATFORM_URL = process.env.PLATFORM_API_URL || process.env.PLATFORM_URL || 'http://47.93.157.83:8080';`
);
applied.push('URL优先PLATFORM_API_URL');

// ============ 2. apiPost 支持新协议(/api/auth/*) 404 回退旧协议 ============
s = s.replace(
  `async function apiPost(path: string, body: any): Promise<PlatformUser> {\n  const res = await fetch(PLATFORM_URL + path, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify(body),\n  });\n  return res.json();\n}`,
  `async function apiPost(path: string, body: any): Promise<PlatformUser> {\n  // V7 新协议: /api/auth/* （本地引擎 3456 侧），404 时回退旧协议 /api/*（云平台 3001 侧）\n  const newPath = '/api/auth' + path.replace(/^\\/api/, '');\n  const tryPaths = [newPath, path];\n  let lastErr: any = null;\n  for (const p of tryPaths) {\n    try {\n      const res = await fetch(PLATFORM_URL + p, {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify(body),\n      });\n      if (res.status === 404) { lastErr = { status: 404 }; continue; } // 新协议没有 → 回退\n      const data = await res.json();\n      return data;\n    } catch (err: any) {\n      lastErr = err;\n      if (err?.cause?.code !== 'ECONNREFUSED' && err?.cause?.code !== 'ENOTFOUND') continue;\n      break; // 连接失败不必再试\n    }\n  }\n  throw lastErr || new Error('平台请求失败');\n}`
);
applied.push('apiPost新协议404回退');

// ============ 3. 注册 payload 对齐 V7 (email/password/display_name) ============
s = s.replace(
  `  const result = await apiPost('/api/register', { username, password });`,
  `  const result = await apiPost('/api/register', { email: username + '@lingxi.local', password, display_name: username, username });`
);
applied.push('自动注册payload对齐V7');

s = s.replace(
  `  const result = await apiPost('/api/register', { username, password, email });`,
  `  const result = await apiPost('/api/register', { email: email || username + '@lingxi.local', password, display_name: username, username });`
);
applied.push('手动注册payload对齐V7');

// ============ 4. 登录 payload 对齐 V7 (email/password) ============
s = s.replace(
  `  const result = await apiPost('/api/login', { username, password });`,
  `  const result = await apiPost('/api/login', { email: username.includes('@') ? username : username + '@lingxi.local', password });`
);
applied.push('登录payload对齐V7');

// ============ 5. PlatformUser 补字段（V7 返回 user 对象） ============
s = s.replace(
  `interface PlatformUser {\n  ok: boolean;\n  id: number;\n  token: string;\n  points?: number;\n  role?: string;\n  error?: string;\n}`,
  `interface PlatformUser {\n  ok: boolean;\n  id: number;\n  token: string;\n  points?: number;\n  role?: string;\n  error?: string;\n  user?: { id?: string | number; numeric_id?: number; numericId?: number; email?: string; display_name?: string; displayName?: string; credits?: number };\n}`
);
applied.push('PlatformUser补user字段');

writeFileSync(F, s, 'utf8');
console.log('Applied patches:', applied.length);
applied.forEach(a => console.log('  ✅', a));
