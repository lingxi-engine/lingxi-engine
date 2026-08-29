import { readFileSync } from 'fs';
const lines = readFileSync('index.ts', 'utf8').split('\n');

// 搜 setupMesh / createMeshRoutes 引用
console.log('=== setupMesh / createMeshRoutes 引用 ===');
lines.forEach((l, i) => {
  if (l.includes('setupMesh') || l.includes('createMeshRoutes')) console.log(`${i+1}: ${l.trim()}`);
});

// L2270-2300 mesh 引擎块开头
console.log('\n=== L2270-2300 (mesh块开头) ===');
for (let i = 2269; i < 2300; i++) console.log(`${i+1}: ${lines[i]}`);