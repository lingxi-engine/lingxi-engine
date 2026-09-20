/**
 * patch-v21.cjs — 根治「改了 .env 却没生效」+ 终极兜底不再谎报模型名
 * 幂等。CRLF 安全。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HUB = path.join(ROOT, 'src', 'ai', 'hub.ts');
const IDX = path.join(ROOT, 'index.ts');
const ENV = path.join(ROOT, '.env');
const MARK = 'patch-v21:applied';

let total = 0;
const log = [];
function readNorm(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  return { src: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf };
}
function writeBack(p, s, crlf) { fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8'); }
function must(c, l) { if (!c) { console.error(`[patch-v21] ✗ 断言失败: ${l}`); process.exit(1); } log.push(`  ✓ ${l}`); }

// ══════════ 1. hub.ts ══════════
const hub = readNorm(HUB);
let s = hub.src;
if (s.includes(MARK)) { log.push('  - hub.ts 已打过，跳过'); }
else {
  must(s.includes('        const fallbackModel = entry.config.models.find((m: string) => /^(llama|qwen)/i.test(m)) || entry.config.models[0];'), 'hub: 定位 v20 本地 fallback 选型');
  must(s.includes('    const firstFallback = firstEntry[1].config.models[0] || model;'), 'hub: 定位 v20 终极兜底');
  const B = s;

  // A. 本地 fallback：优先云端中继壳（远端推理），并区分「真本机推理」
  s = s.replace(
`        const fallbackModel = entry.config.models.find((m: string) => /^(llama|qwen)/i.test(m)) || entry.config.models[0];`,
`        // ${MARK}：优先选「云端中继壳」（远端推理），避免直接掉进本机 CPU
        const shell = entry.config.models.find((m: string) => /:(cloud|remote)$|-cloud$/i.test(m));
        const fallbackModel = shell || entry.config.models.find((m: string) => /^(llama|qwen)/i.test(m)) || entry.config.models[0];
        const realLocal = !/:(cloud|remote)$|-cloud$/i.test(fallbackModel);`);

  s = s.replace(
`        if (!allowLocalFallback) {
          console.error(detail + ' [LINGXI_ALLOW_LOCAL_FALLBACK=false → 拒绝降级，返回 null]');
          return null;
        }
        console.error(detail + ' [LINGXI_ALLOW_LOCAL_FALLBACK=true → 已放行，标记 degraded=true]');`,
`        if (realLocal && !allowLocalFallback) {
          console.error(detail + \` [\${fallbackModel} 属真本机推理且 LINGXI_ALLOW_LOCAL_FALLBACK=false → 拒绝，返回 null]\`);
          return null;
        }
        console.error(detail + \` [\${realLocal ? '真本机推理' : '云端中继壳'} → 已放行，标记 degraded=true]\`);`);
  s = s.replace(
`        return { client: entry.client, resolvedModel: fallbackModel, providerId: pid, isLocal: true, degraded: true };`,
`        return { client: entry.client, resolvedModel: fallbackModel, providerId: pid, isLocal: !!entry.config.isLocal, degraded: true };`);

  // B. 终极兜底：不再谎报；真本机推理受开关约束
  s = s.replace(
`    const firstFallback = firstEntry[1].config.models[0] || model;
    console.error(\`[AI Hub][DEGRADED] 模型 "\${model}" 无处可去 → 终极兜底 \${firstEntry[0]}/\${firstFallback}\`);
    return { client: firstEntry[1].client, resolvedModel: firstFallback, providerId: firstEntry[0], isLocal: !!firstEntry[1].config.isLocal, degraded: true };`,
`    // ${MARK} ★ 不谎报：models 未同步时不能把请求名当"已解析"；真本机推理受开关约束
    const firstCfg = firstEntry[1].config;
    const firstModels: string[] = Array.isArray(firstCfg.models) ? firstCfg.models : [];
    const allowLocal2 = String(process.env.LINGXI_ALLOW_LOCAL_FALLBACK || 'false').toLowerCase() !== 'false';
    if (firstModels.length === 0) {
      console.error(
        \`[AI Hub][MODEL-UNVERIFIED] 模型 "\${model}" 无处可去且 provider \${firstEntry[0]} 型号清单为空\` +
        \`（可能 Ollama 未同步）→ 仍按 \${model} 发给该 provider，但标记 degraded（未经校验）\`
      );
      return { client: firstEntry[1].client, resolvedModel: model, providerId: firstEntry[0], isLocal: !!firstCfg.isLocal, degraded: true };
    }
    const firstFallback = firstModels[0];
    const firstRealLocal = !!firstCfg.isLocal && !/:(cloud|remote)$|-cloud$/i.test(firstFallback);
    console.error(
      \`[AI Hub][DEGRADED-TO-LOCAL] 模型 "\${model}" 无处可去 → 仅剩 \${firstEntry[0]}/\${firstFallback}\` +
      \` (真本机推理=\${firstRealLocal}, allowLocalFallback=\${allowLocal2})\`
    );
    if (firstRealLocal && !allowLocal2) {
      console.error('[AI Hub][FATAL] 唯一可用 provider 为真本机推理且开关关闭 → 返回 null（拒绝静默降级）');
      return null;
    }
    return { client: firstEntry[1].client, resolvedModel: firstFallback, providerId: firstEntry[0], isLocal: !!firstCfg.isLocal, degraded: true };`);

  must(s !== B, 'hub: 已应用修改');
  must(s.includes(MARK), 'hub: 标记写入');
  writeBack(HUB, s, hub.crlf); total++;
  log.push(`  ✓ hub.ts 写回 (${fs.statSync(HUB).size} B)`);
}

// ══════════ 2. index.ts — .env 遮蔽诊断 + 可覆盖 ══════════
const ix = readNorm(IDX);
let i = ix.src;
if (i.includes(MARK)) { log.push('  - index.ts 已打过，跳过'); }
else {
  must(i.includes("import 'dotenv/config';"), 'index: 定位 dotenv 导入');
  const B2 = i;
  i = i.replace("import 'dotenv/config';", `import 'dotenv/config';
// ── ${MARK} ★ .env 生效性诊断与覆盖 ──────────────────────────────────────
// 背景：dotenv 默认「不覆盖」已存在于 process.env 的键。若服务由带环境变量的父进程拉起
//（Windows 服务 / IDE / 上层平台 / setx），.env 会被静默遮蔽 → 表现为「改了 .env 却没生效」，
// 且模型路由会跑到意料之外的模型（例如本机 Ollama）上，全程无任何提示。
(() => {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!existsSync(envPath)) return;
    const fileVals = new Map<string, string>();
    for (const rawLine of readFileSync(envPath, 'utf8').split(/\\r?\\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      fileVals.set(k, v);
    }
    const override = String(process.env.LINGXI_ENV_OVERRIDE ?? 'true').toLowerCase() !== 'false';
    const mask = (x: string) => (!x ? x : x.length <= 10 ? x.slice(0, 3) + '***' : x.slice(0, 8) + '***');
    const shadows: string[] = [];
    for (const [k, fv] of fileVals) {
      const pv = process.env[k];
      if (pv === undefined) { process.env[k] = fv; continue; }
      if (pv === fv) continue;
      shadows.push(\`\${k}: 进程=\${mask(pv)} / .env=\${mask(fv)}\`);
      if (override) process.env[k] = fv;
    }
    if (shadows.length > 0) {
      console.warn(\`[ENV-SHADOW] ⚠️ 检测到 \${shadows.length} 个键被父进程环境遮蔽（dotenv 默认不覆盖）\`);
      shadows.forEach(l => console.warn(\`[ENV-SHADOW]   \${l}\`));
      console.warn(override
        ? '[ENV-SHADOW] → 已按 .env 覆盖（LINGXI_ENV_OVERRIDE=false 可关闭该行为）'
        : '[ENV-SHADOW] → 保留进程环境值，.env 未生效！');
    } else {
      console.log(\`[ENV-SHADOW] .env 未被遮蔽（\${fileVals.size} 个键一致）\`);
    }
    console.log(\`[ENV] 生效模型配置: DEFAULT_MODEL=\${process.env.DEFAULT_MODEL || '(未设)'} | TOOL_MODEL=\${process.env.TOOL_MODEL || '(未设)'} | REPLY_MODEL=\${process.env.REPLY_MODEL || '(未设)'} | ROUTE_ENABLED=\${process.env.ROUTE_ENABLED || '(未设)'} | ALLOW_LOCAL_FALLBACK=\${process.env.LINGXI_ALLOW_LOCAL_FALLBACK || '(未设)'}\`);
  } catch (e) {
    console.warn('[ENV-SHADOW] 诊断失败（不影响启动）:', (e as Error).message);
  }
})();`);
  must(i !== B2, 'index: 已应用修改');
  writeBack(IDX, i, ix.crlf); total++;
  log.push(`  ✓ index.ts 写回 (${fs.statSync(IDX).size} B)`);
}

// ══════════ 3. .env — 开关 ══════════
const ev = readNorm(ENV);
let e = ev.src;
if (e.includes(MARK)) { log.push('  - .env 已打过，跳过'); }
else {
  e = e.replace(/\s*$/, `\n# ${MARK}: .env 是否覆盖父进程环境变量（true = 以 .env 为准，修复"改了 .env 没生效"）
LINGXI_ENV_OVERRIDE=true
`);
  must(e.includes('LINGXI_ENV_OVERRIDE=true'), '.env: 开关已写入');
  writeBack(ENV, e, ev.crlf); total++;
  log.push(`  ✓ .env 写回 (${fs.statSync(ENV).size} B)`);
}

// ══════════ 4. 清理失败备份产生垃圾文件 ══════════
const junk = path.join(ROOT, '.env.bak-%TS%');
if (fs.existsSync(junk)) { fs.unlinkSync(junk); log.push('  ✓ 已删除垃圾文件 .env.bak-%TS%（上次变量未展开产生）'); total++; }

console.log(`[patch-v21] 完成，改动文件数 = ${total}`);
log.forEach(l => console.log(l));
console.log('\n下一步：npx tsc --noEmit && npx tsx bench/verify-v21.ts');
