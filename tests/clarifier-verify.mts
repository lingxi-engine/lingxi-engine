// Clarifier 接线回归测试
// 运行: npx tsx tests/clarifier-verify.mts
// 覆盖三类行为: 硬拦截 / 软提示 / 任务放行
import { Clarifier } from '../src/core/clarifier.ts';

// 复制 router.ts 的 _looksLikeTask（判定任务类，任务类不拦）
function _looksLikeTask(content: string): boolean {
  if (!content) return false;
  const t = content.trim();
  if (/[?？]$/.test(t)) return false;
  if (/^(为什么|为啥|怎么|如何|是什么|什么是|是不是|能不能|可不可以|有没有|哪个|哪些|多少|who|what|why|how|when|where|is |are |can |do |does )/i.test(t)) return false;
  const lower = t.toLowerCase();
  const strongWords = ['分析', '重构', '审计', '部署', '迁移', '优化', '生成', '实现', '编写', '打包', '上传', '排查', '定位', '对比', '评估', '梳理', '整理', '搭建', '搞定', 'analyze', 'analyse', 'refactor', 'deploy', 'migrate', 'optimize', 'generate', 'implement', 'debug', 'build'];
  for (const w of strongWords) if (lower.includes(w.toLowerCase())) return true;
  if (/^(帮我|请你|麻烦你|给我|替我|来来)/.test(t)) return true;
  if (/^(写|做个|做|干|弄|搞)[一个|个|一下|个]?/.test(t)) return true;
  const actionWords = ['修复', '修', '改', '修改', '写', '创建', '新建', '添加', '增加', '删除', '移除', '更新', '检查', '配置', '安装', '合并', '拆分', '建立', '验证', '测试', '统计', '转换', '处理', '搞定', '干', '做', '完成', '解决', 'fix', 'write', 'create', 'add', 'remove', 'update', 'check', 'config', 'install', 'test'];
  let hits = 0;
  for (const w of actionWords) { if (lower.includes(w.toLowerCase())) { hits++; if (hits >= 2) break; } }
  if (hits >= 2) return true;
  if (hits >= 1 && t.length > 40) return true;
  return false;
}

// 模拟 router 的拦截判定（与 router.ts generateReply 入口逻辑一致）
function shouldClarify(input: string, taskGoal?: string, customPrompt?: string, skipPersist?: boolean): { blocked: boolean; score?: number; reasons?: string[]; note: string } {
  if (taskGoal || customPrompt || skipPersist) return { blocked: false, note: '跳过（非普通对话场景）' };
  if (_looksLikeTask(input)) return { blocked: false, note: '跳过（任务类输入）' };
  const c = new Clarifier();
  const r = c.evaluate(input, false, []);
  if (r.needsClarify) return { blocked: true, score: r.score, reasons: r.reasons.map(x => x.dimension), note: '硬拦截' };
  if (r.score < c.softThreshold) return { blocked: false, score: r.score, reasons: r.reasons.map(x => x.dimension), note: '软提示注入 system prompt' };
  return { blocked: false, score: r.score, reasons: r.reasons.map(x => x.dimension), note: '放行' };
}

const cases: [string, string, boolean][] = [
  // [输入, 描述, 期望是否硬拦截]
  ['它，这个，那个', '高歧义：多个模糊指代', true],
  ['上面那个它', '上下文依赖+指代模糊', true],
  ['随便看看，差不多就行', '模糊用语', true],
  ['帮我查一下今天的天气', '正常任务指令（任务类不拦）', false],
  ['你好', '正常打招呼', false],
  ['这个功能怎么用', '单指代+疑问（soft）', false],
  ['分析一下这份报告', '任务类（不拦）', false],
  ['帮我写个总结', '任务类（不拦）', false],
  ['嗯', '极短输入', false],
  ['帮我看看这个', '任务类+指代（不拦，任务优先）', false],
  // 补充边界用例
  ['还有顺便另外同时', '多意图连接词（不硬拦，软处理）', false],
  ['写个500字的方案，要详细一点', '长任务指令（不拦）', false],
  ['那个文件怎么打开', '单指代+疑问（soft）', false],
];

let pass = 0, fail = 0;
for (const [input, label, expectBlock] of cases) {
  const r = shouldClarify(input);
  const match = (r.blocked === expectBlock);
  if (match) pass++; else fail++;
  console.log(`${match ? '✅' : '❌'} [${label}] "${input}" → ${r.note}${r.score !== undefined ? ` (score=${r.score})` : ''}${r.reasons?.length ? ` [${r.reasons.join(',')}]` : ''}${match ? '' : ` 期望=${expectBlock ? '拦截' : '不拦截'}`}`);
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
