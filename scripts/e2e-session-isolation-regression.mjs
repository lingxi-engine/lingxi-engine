/**
 * 回归对照：用「修复前」的 app.js 跑同一套 E2E，验证测试确实能捕捉到串会话 bug。
 * 目的：证明 E2E 不是假阳性 —— 旧代码必须 FAIL，新代码必须 PASS。
 */
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const APP = 'C:/Users/Administrator/lingxi-engine/web/js/app.js';
const BAK = 'C:/Users/Administrator/lingxi-engine/web/js/app.js.bak-session-isolation-20261025';
const CUR = readFileSync(APP, 'utf8');

// 构造「修复前」版本：把本次新增的会话隔离守卫全部移除
let old = CUR;

// 1) appendStreamingMsg 的隔离分支
old = old.replace(
  /function appendStreamingMsg\(msg\) \{\n  \/\/ ⭐ 会话隔离：[\s\S]*?\n    return;\n  \}\n/,
  'function appendStreamingMsg(msg) {\n'
);
// 2) streaming.start 的当前会话判断
old = old.replace(
  /      \/\/ ⭐ 会话隔离：不在当前会话时只记账[\s\S]*?      if \(!msg\.chatId \|\| msg\.chatId === currentChat\) \{\n        appendStreamingMsg\(msg\);\n      \}\n/,
  '      appendStreamingMsg(msg);\n'
);
// 3) buildStreamBubble 守卫
old = old.replace(
  /  \/\/ 切走后的迟到段：不要把气泡挂进当前会话的消息区\n  if \(!container \|\| \(s && s\.chatId && currentChat && s\.chatId !== currentChat\)\) return null;\n/,
  ''
);
// 4) ensureStreamSegment 守卫
old = old.replace(
  /  if \(s\.chatId && currentChat && s\.chatId !== currentChat\) return;\n/,
  ''
);

if (old === CUR) {
  console.error('❌ 未能构造旧版本（替换未命中）');
  process.exit(2);
}

writeFileSync(APP, old, 'utf8');
console.log('已切换到「修复前」版本，长度 ' + old.length + '（当前 ' + CUR.length + '）');

let code = 0;
try {
  execSync('node workspace/e2e-session-isolation.mjs', {
    cwd: 'C:/Users/Administrator/lingxi-engine',
    encoding: 'utf8',
    stdio: 'pipe',
  });
  console.log('\n⚠️ 旧版本居然通过了 —— 测试是假阳性！需要加强');
  code = 3;
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  console.log('\n✅ 旧版本如预期失败（测试有效）：');
  out.split('\n').filter((l) => /❌|结果/.test(l)).forEach((l) => console.log('   ' + l.trim()));
  code = 0;
} finally {
  writeFileSync(APP, CUR, 'utf8');
  console.log('\n已恢复修复后的版本');
}

process.exit(code);
