// 精确文本替换工具（多组替换，UTF-8 无 BOM，保留 LF）
// 用法: node scripts/apply-patches.mjs <targetFile> <jsonSpecFile>
import { readFileSync, writeFileSync } from 'fs';

const [, , file, specFile] = process.argv;
if (!file || !specFile) { console.error('参数不足'); process.exit(2); }

let src = readFileSync(file, 'utf8');
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
let ok = 0, fail = [];

for (const [idx, item] of spec.entries()) {
  const old = item.old;
  const neu = item.new;
  const count = src.split(old).length - 1;
  if (count === 0) { fail.push(`#${idx} 未找到: ${JSON.stringify(old.slice(0, 70))}`); continue; }
  if (count > 1) { fail.push(`#${idx} 出现 ${count} 次（需唯一）: ${JSON.stringify(old.slice(0, 70))}`); continue; }
  src = src.replace(old, neu);
  ok++;
  console.log(`✅ #${idx} 已替换`);
}

if (fail.length) {
  console.error('\n❌ 失败项：');
  fail.forEach(f => console.error('  ' + f));
  process.exit(1);
}

writeFileSync(file, src, 'utf8');
console.log(`\n🎉 共替换 ${ok} 组，写入 ${file}`);
