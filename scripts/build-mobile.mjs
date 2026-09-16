/**
 * 灵犀引擎 - 移动端引擎构建脚本
 *
 * 把 src/mobile/index.ts 打包成单文件 CJS，供 nodejs-mobile 运行：
 *   1. esbuild bundle（平台 node，目标 node18，产物 mobile-dist/lingxi-mobile.js）
 *   2. 复制 native 运行时文件（sql.js wasm 等，保持 sql.js 期望的原文件名）
 *   3. 同步到 Android / iOS 工程的 nodejs-project 目录（以工程根存在为判断）
 *
 * 用法：node scripts/build-mobile.mjs
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'mobile-dist');
const OUT_FILE = join(OUT_DIR, 'lingxi-mobile.js');

// nodejs-mobile 里无法被 esbuild 内联的原生/特殊模块
const EXTERNAL = [
  'nodejs-mobile-react-native',
  '@nodejs-mobile/react-native',
];

function log(msg) { console.log(`[build-mobile] ${msg}`); }
function ok(msg) { console.log(`[build-mobile] ✅ ${msg}`); }
function warn(msg) { console.log(`[build-mobile] ⚠️ ${msg}`); }

async function main() {
  log(`ROOT=${ROOT}`);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // ── 1. esbuild bundle ──
  const result = await build({
    entryPoints: [join(ROOT, 'src', 'mobile', 'index.ts')],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',            // nodejs-mobile 运行时按 CJS 加载最稳
    target: 'node18',
    external: EXTERNAL,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    define: { 'process.env.LINGXI_MOBILE': '"1"' },
    loader: { '.node': 'file' },
  });

  const bytes = statSync(OUT_FILE).size;
  const modules = Object.keys(result.metafile.inputs).length;
  ok(`bundle 完成：${OUT_FILE} (${(bytes / 1024).toFixed(1)} KB, ${modules} 个源文件)`);

  // ── 1.5 产物目录声明 commonjs（避免被仓库根 package.json 的 type:module 干扰，桌面冒烟/加载均可用） ──
  const pkgCjs = join(OUT_DIR, 'package.json');
  writeFileSync(pkgCjs, JSON.stringify({ type: 'commonjs' }, null, 2));

  // ── 2. 复制 native 运行时文件（sql.js wasm 等） ──
  // 注意：必须保持 sql.js 期望的原文件名（sql-wasm.wasm / sql-wasm.js），
  // 运行时按原名 locateFile，改名会导致启动即挂。
  const runtimeAssets = [];
  const sqlWasm = join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const sqlJs = join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
  for (const f of [sqlWasm, sqlJs]) {
    if (existsSync(f)) {
      const name = f.split(/[\\/]/).pop();
      copyFileSync(f, join(OUT_DIR, name));
      runtimeAssets.push(name);
    }
  }
  if (runtimeAssets.length) ok(`已复制 sql.js 运行时：${runtimeAssets.join(', ')}`);
  else warn('未找到 sql.js dist 文件（若引擎用纯 JS 存储可忽略）');

  // ── 3. 同步到原生工程 ──
  // probe：工程骨架存在的标志路径；dir：引擎产物放哪
  const targets = [
    {
      name: 'Android',
      probe: join(ROOT, 'app', 'android', 'app', 'src', 'main'),
      dir: join(ROOT, 'app', 'android', 'app', 'src', 'main', 'assets', 'nodejs-project'),
    },
    {
      name: 'iOS',
      probe: join(ROOT, 'app', 'ios', 'App', 'App'),
      dir: join(ROOT, 'app', 'ios', 'App', 'App', 'nodejs-project'),
    },
  ];
  for (const t of targets) {
    if (!existsSync(t.probe)) {
      warn(`${t.name} 工程不存在，跳过（probe: ${t.probe}）`);
      continue;
    }
    if (!existsSync(t.dir)) mkdirSync(t.dir, { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
    copyFileSync(OUT_FILE, join(t.dir, 'lingxi-mobile.js'));
    for (const a of runtimeAssets) copyFileSync(join(OUT_DIR, a), join(t.dir, a));
    ok(`${t.name} 已同步：${t.dir}`);
  }

  log('全部完成。下一步：cd app && npx cap sync android && npx cap build android');
}

main().catch((e) => { console.error('[build-mobile] ❌ 失败：', e.message); process.exit(1); });
