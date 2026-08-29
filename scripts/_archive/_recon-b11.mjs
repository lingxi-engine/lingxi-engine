// 批次11 开工侦察：核实所有目标块位置
import { readFileSync } from 'fs';

const lines = readFileSync('index.ts', 'utf8').split('\n');
console.log('总行数:', lines.length);

function find(pat, label) {
  const hits = [];
  lines.forEach((l, i) => {
    if (l.includes(pat)) hits.push(i + 1);
  });
  console.log(`[${label}] "${pat}" -> 行:`, hits.slice(0, 12).join(', ') || '无');
  return hits;
}

// 1. mesh REST 块
find('// Mesh REST API', 'mesh标题');
find("app.get('/api/mesh", 'mesh路由');
find("app.post('/api/mesh", 'mesh路由POST');

// 2. profile GET 块
find('// 用户资料', 'profile标题');
find("app.get('/api/profile", 'profile路由');
find("app.post('/api/profile", 'profile路由POST');
find('/api/profile/ratings', 'ratings路由');

// 3. federation 块
find('// Federation', 'fed标题');
find("app.get('/api/federation", 'fed路由');
find("app.post('/api/federation", 'fed路由POST');

// 4. workspace-mode / tags / time
find("app.get('/api/workspace-mode", 'ws-mode');
find("app.post('/api/workspace-mode", 'ws-mode');
find("app.get('/api/tags", 'tags');
find("app.get('/api/time", 'time');

// 5. 挂载点
find('registerMiscRoutes', 'misc挂载');
find('registerProfileRoutes', 'profile挂载');
find('registerUploadRoutes', 'upload挂载');
find("from './src/routes/upload", 'upload import');
find("from './src/routes/misc", 'misc import');
find("from './src/routes/profile", 'profile import');

// 6. /api/update 活路由（不能碰）
find("app.get('/api/update", 'update路由');

// 7. /api/chats 相关（跨模块重复）
find("app.get('/api/chats", 'chats GET');
find("app.post('/api/chats", 'chats POST');