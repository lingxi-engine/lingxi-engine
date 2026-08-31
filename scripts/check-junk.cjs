// 垃圾文件门禁：CI/提交前检查 src/ 下是否混入备份文件（防止 .~N~ / .bak 回潮）
// 用法: node scripts/check-junk.cjs
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SCAN = [path.join(ROOT, 'src'), path.join(ROOT, 'index.ts'), path.join(ROOT, 'package.json')];

const junkRe = /~[0-9]+~$|\.bak([.\-]|$)|\.rollback-|\.func$/i;
const found = [];

function walk(d, dep = 0) {
  if (dep > 6) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', '_junk_archive_20260824'].includes(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, dep + 1);
    else if (junkRe.test(e.name)) found.push(path.relative(ROOT, f));
  }
}
for (const root of SCAN) {
  if (fs.existsSync(root)) {
    if (fs.statSync(root).isDirectory()) walk(root);
    else if (junkRe.test(path.basename(root))) found.push(path.basename(root));
  }
}

if (found.length) {
  console.error(`❌ 发现 ${found.length} 个垃圾文件，请清理：`);
  found.slice(0, 30).forEach(f => console.error('  ' + f));
  process.exit(1);
}
console.log('✅ 源码目录干净，无备份/临时文件混入');
