#!/usr/bin/env node
/**
 * test-clean-env.mjs — 在「CI 干净环境」下跑测试，防复发「本地绿 ≠ CI 绿」。
 *
 * 背景（2026-11-25 三次红灯的共同根因类）：
 *   开发机系统级 LINGXI_STRICT_MODEL=true / 各家 API Key 会掩盖代码路径。
 *   例：b2beb81 修复前，probeModel 对无法解析模型返回 degraded 替身而非 null，
 *   但开发机的 LINGXI_STRICT_MODEL=true 把 degraded 拒成 null，本地测试假绿；
 *   CI 干净环境（无 Key/无 .env/无 LINGXI_*）才暴露真失败。
 *
 * 做法：从 process.env 剥离所有 LINGXI_* / 供应商凭证 / 模型路由变量，
 *   仅保留 OS 必需变量（PATH/SYSTEMROOT/HOME 等），spawn 子进程跑 vitest。
 *   vitest 套件不自动加载 .env（已核实 vitest.config.ts 无 dotenv/setup），
 *   故剥离子进程 env 即可忠实复现 CI。
 *
 * 用法：
 *   npm run test:clean-env                          # 全量套件
 *   npm run test:clean-env -- src/tests/model-health.test.ts   # 指定文件
 *   npm run test:clean-env -- --coverage            # 透传 vitest 参数
 *
 * 安全：只打印被剥离变量的「名字」，绝不打印值。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STRIP_PATTERNS = [
  /^LINGXI_/i,
  /_API_KEY$/i,
  /_BASE_URL$/i,
  /^AI_HUB_/i,
  /^(DEFAULT_MODEL|TOOL_MODEL|REPLY_MODEL|ROUTE_ENABLED)$/i,
  /^(OPENAI|ANTHROPIC|NVIDIA|DEEPSEEK|MOONSHOT|KIMI|MINIMAX|QWEN|BAIDU|YI|BAICHUAN|STEPFUN|SILICONFLOW|IFLYTEK|VOLCENGINE|TENCENT|GOOGLE|GROQ|MISTRAL|XAI|OPENROUTER|TOGETHER|FIREWORKS|PERPLEXITY|ZHIPU|OLLAMA)_/i,
];

const shouldStrip = (key) => STRIP_PATTERNS.some((p) => p.test(key));

const childEnv = {};
const stripped = [];
for (const [k, v] of Object.entries(process.env)) {
  if (shouldStrip(k)) {
    stripped.push(k);
  } else {
    childEnv[k] = v;
  }
}
stripped.sort();

// 断言已知的「掩盖变量」确实被剥离，否则脚本失去意义。
const MUST_STRIP = ['LINGXI_STRICT_MODEL', 'LINGXI_ALLOW_LOCAL_FALLBACK', 'LINGXI_CLOUD_SUFFIX_STRICT'];
const stillPresent = MUST_STRIP.filter((k) => k in childEnv);
if (stillPresent.length) {
  console.error('[clean-env] FATAL: 掩盖变量未被剥离:', stillPresent.join(', '));
  process.exit(2);
}

console.log('========================================================');
console.log('[clean-env] 模拟 CI 干净环境（无 Key / 无 .env / 无 LINGXI_*）');
console.log(`[clean-env] 已剥离 ${stripped.length} 个敏感环境变量:`);
console.log('  ' + (stripped.join(', ') || '(本机本就干净)'));
console.log('[clean-env] 保留 OS 必需变量，spawn vitest 子进程');
console.log('========================================================');

const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestBin)) {
  console.error('[clean-env] FATAL: 找不到 vitest 入口:', vitestBin, '（先 npm ci）');
  process.exit(2);
}

const extraArgs = process.argv.slice(2);
const args = [vitestBin, 'run', ...extraArgs];
const r = spawnSync(process.execPath, args, {
  env: childEnv,
  stdio: 'inherit',
  cwd: process.cwd(),
});

if (r.error) {
  console.error('[clean-env] spawn 失败:', r.error.message);
  process.exit(2);
}
const code = r.status == null ? 1 : r.status;
console.log('========================================================');
console.log(`[clean-env] vitest 退出码 = ${code} ${code === 0 ? '✅ 干净环境下全绿（与 CI 一致）' : '❌ 干净环境下有失败（本地假绿被揪出）'}`);
console.log('========================================================');
process.exit(code);
