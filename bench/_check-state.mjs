import fs from 'fs';
import path from 'path';

const ROOT = 'C:/Users/Administrator/lingxi-engine';

function check(label, file, checks) {
  console.log(`\n=== ${label} ===`);
  if (!fs.existsSync(file)) { console.log(`  MISSING: ${file}`); return; }
  const content = fs.readFileSync(file, 'utf8');
  for (const [desc, pattern, shouldExist] of checks) {
    const found = content.includes(pattern);
    const status = found === shouldExist ? 'OK' : 'FAIL';
    console.log(`  [${status}] ${desc}: ${found ? 'present' : 'absent'}`);
  }
}

// 1. ws-handler.ts — v31 应该已删除 setSessionWorkspaceSubdir 调用
check('ws-handler.ts (v31 applied?)',
  path.join(ROOT, 'src/core/ws-handler.ts'),
  [
    ['setSessionWorkspaceSubdir 调用行已删除', 'if (meta && meta.bench && meta.sbx) setSessionWorkspaceSubdir(meta.sbx);', false],
    ['import setSessionWorkspaceSubdir 已删除', 'import { setSessionWorkspaceSubdir } from "../tools/builtin.js";', false],
    ['message case 仍存在', 'case "message":', true],
    ['agent.task case 仍存在', 'case "agent.task":', true],
  ]
);

// 2. builtin.ts — v30 的 safePath 修改应该还在（无害但防御性）
check('builtin.ts (v30 safePath)',
  path.join(ROOT, 'src/tools/builtin.ts'),
  [
    ['setSessionWorkspaceSubdir 函数存在', 'setSessionWorkspaceSubdir', true],
    ['_sessionSubdir 变量存在', '_sessionSubdir', true],
    ['sessionRoot 函数存在', 'function sessionRoot()', true],
  ]
);

// 3. ws-adapter.cjs — 检查 sbx 传参
const adapterPaths = [
  path.join(ROOT, 'workspace/bench/adapters/ws-adapter.cjs'),
  path.join(ROOT, 'src/.../ws-adapter.cjs'),
];
for (const ap of adapterPaths) {
  if (fs.existsSync(ap)) {
    check('ws-adapter.cjs', ap, [
      ['sbx 参数传递', 'sbx:', true],
    ]);
    break;
  }
}

// 4. 找所有 ws-adapter 相关文件
console.log('\n=== 找 ws-adapter 文件 ===');
function findAdapter(dir, depth=0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findAdapter(full, depth+1);
    else if (/ws-adapter/.test(e.name)) console.log(`  FOUND: ${full}`);
  }
}
findAdapter(ROOT);

// 5. 找测试/运行脚本
console.log('\n=== bench 运行脚本 ===');
const benchDir = path.join(ROOT, 'bench');
if (fs.existsSync(benchDir)) {
  const items = fs.readdirSync(benchDir);
  for (const item of items) {
    if (/(run|smoke|verify|judge|test|agg)/i.test(item)) {
      console.log(`  ${item}`);
    }
  }
}

// 6. 检查 ts 编译状态
console.log('\n=== tsc 检查 ===');
const tsConfig = path.join(ROOT, 'tsconfig.json');
if (fs.existsSync(tsConfig)) {
  console.log('  tsconfig.json exists');
} else {
  console.log('  no tsconfig.json');
}

console.log('\n=== done ===');
