/**
 * patch-v20.cjs — 模型归属可见化 + 掐断「静默降级到本地」
 * 幂等：已打过则跳过。CRLF 安全。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HUB = path.join(ROOT, 'src', 'ai', 'hub.ts');
const ROUTER = path.join(ROOT, 'src', 'core', 'router.ts');
const ENV = path.join(ROOT, '.env');

const MARK = 'patch-v20:applied';
let total = 0;
const log = [];

// ── CRLF 归一化读取 ──
function readNorm(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  return { src: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf };
}
function writeBack(p, src, crlf) {
  fs.writeFileSync(p, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
}
function must(cond, label) {
  if (!cond) { console.error(`[patch-v20] ✗ 断言失败: ${label}`); process.exit(1); }
  log.push(`  ✓ ${label}`);
}

// ══════════════════════════════════════════
// 1. hub.ts
// ══════════════════════════════════════════
const hub = readNorm(HUB);
let s = hub.src;
if (s.includes(MARK)) {
  log.push('  - hub.ts 已打过，跳过');
} else {
  must(s.includes('export interface AIProviderConfig {'), 'hub: 定位 AIProviderConfig');
  must(s.includes('  getClient(model: string): { client: OpenAI; resolvedModel: string } | null {'), 'hub: 定位 getClient 签名');
  must(s.includes('      if (entry.config.models.some(m => model === m)) {\n        return { client: entry.client, resolvedModel: model };'), 'hub: 定位第1步精确匹配');
  must(s.includes('        console.log(`[AI Hub] 模型 "${model}" 不可用，fallback 到本地: ${fallbackModel}`);'), 'hub: 定位本地 fallback');
  must(s.includes('    // 6. 最后兜底\n    const first = this.providers.values().next().value;'), 'hub: 定位终极兜底');
  must(s.includes('    if (result && result.resolvedModel !== model) {'), 'hub: 定位 getRoleClient 漂移检测');

  const B0 = s;

  // A. 新增 AIResolvedClient 类型
  s = s.replace('export interface AIProviderConfig {',
`/** ${MARK} — 解析结果（带来源标记，供「模型归属可见化」使用） */
export interface AIResolvedClient {
  client: OpenAI;
  resolvedModel: string;
  /** 实际服务的 provider id */
  providerId?: string;
  /** 注意：Ollama 转发壳（glm-5.2:cloud 等）也算 isLocal，因为它们经本机 daemon 转发 */
  isLocal?: boolean;
  /** true = 请求的模型未被精确命中，属降级结果 */
  degraded?: boolean;
}

export interface AIProviderConfig {`);

  // B. 签名放宽
  s = s.replace('  getClient(model: string): { client: OpenAI; resolvedModel: string } | null {',
                '  getClient(model: string): AIResolvedClient | null {');

  // C. 第1步：精确匹配 → 非本地优先 + :cloud 壳守卫
  s = s.replace(
`    // 1. 精确匹配
    for (const [, entry] of this.providers) {
      if (entry.config.models.some(m => model === m)) {
        return { client: entry.client, resolvedModel: model };
      }
    }`,
`    // 1. 精确匹配（${MARK}：同名命中多个 provider 时优先「非本地」）
    //    根因修复：providers Map 中 local-ollama 注册最早，其动态模型清单含 "glm-5.2:cloud"
    //    这类转发壳，会把同名云请求静默劫持到本机 Ollama（isLocal=true）。
    const exactHits: { pid: string; entry: any }[] = [];
    for (const [pid, entry] of this.providers) {
      if (entry.config.models.some((m: string) => model === m)) exactHits.push({ pid, entry });
    }
    if (exactHits.length > 0) {
      const cloudHit = exactHits.find(h => !h.entry.config.isLocal);
      if (cloudHit) {
        return { client: cloudHit.entry.client, resolvedModel: model, providerId: cloudHit.pid, isLocal: false, degraded: false };
      }
      // 只命中本地：若请求名是 Ollama 云端转发壳（:cloud/:free 等）而规范化名在云 provider 存在 → 改走云端
      const strictCloudSuffix = String(process.env.LINGXI_CLOUD_SUFFIX_STRICT || 'true').toLowerCase() !== 'false';
      if (strictCloudSuffix && /:(cloud|remote)$/i.test(model)) {
        const nm = this.normalizeModelName(model);
        for (const [pid, e2] of this.providers) {
          if (!e2.config.isLocal && e2.config.models.some((m: string) => m === nm)) {
            console.warn(\`[AI Hub][MODEL] "\${model}" 是 Ollama 转发壳且只命中本地 → 规范化名 "\${nm}" 在云 provider \${pid} 存在，改走云端\`);
            return { client: e2.client, resolvedModel: nm, providerId: pid, isLocal: false, degraded: false };
          }
        }
      }
      console.warn(\`[AI Hub][MODEL] "\${model}" 精确命中 \${exactHits.length} 个 provider 且均为本地：\${exactHits.map(h => h.pid).join(',')}\`);
      const pick = exactHits[0];
      return { client: pick.entry.client, resolvedModel: model, providerId: pick.pid, isLocal: true, degraded: false };
    }`);

  // D. 第2步：规范化精确匹配 → 非本地优先
  s = s.replace(
`    if (strippedModel !== model) {
      for (const [, entry] of this.providers) {
        if (entry.config.models.some(m => strippedModel === m)) {
          return { client: entry.client, resolvedModel: strippedModel };
        }
      }`,
`    if (strippedModel !== model) {
      // ${MARK}：规范化后同样优先非本地
      const normHits: { pid: string; entry: any }[] = [];
      for (const [pid, entry] of this.providers) {
        if (entry.config.models.some((m: string) => strippedModel === m)) normHits.push({ pid, entry });
      }
      if (normHits.length > 0) {
        const c = normHits.find(h => !h.entry.config.isLocal);
        const p = c || normHits[0];
        if (!c) console.warn(\`[AI Hub][MODEL] "\${model}" 规范化后 "\${strippedModel}" 只命中本地 provider：\${p.pid}\`);
        return { client: p.entry.client, resolvedModel: strippedModel, providerId: p.pid, isLocal: !!p.entry.config.isLocal, degraded: false };
      }`);

  // E. 第3步：前缀匹配 → 非本地优先
  s = s.replace(
`    for (const [pid, entry] of this.providers) {
      if (entry.config.models.some(m => model.includes(m) || m.includes(model))) {
        if (model.toLowerCase().includes(pid.toLowerCase()) || pid.toLowerCase().includes(model.split("-")[0])) {
          const matchedModel = entry.config.models.find(m => model.includes(m) || m.includes(model));
          return { client: entry.client, resolvedModel: matchedModel || model };
        }
      }
    }`,
`    const prefixHits: { pid: string; entry: any; matched: string }[] = [];
    for (const [pid, entry] of this.providers) {
      const m0 = entry.config.models.find((m: string) => model.includes(m) || m.includes(model));
      if (!m0) continue;
      if (model.toLowerCase().includes(pid.toLowerCase()) || pid.toLowerCase().includes(model.split("-")[0])) {
        prefixHits.push({ pid, entry, matched: m0 });
      }
    }
    if (prefixHits.length > 0) {
      const ordered = prefixHits.filter(h => !h.entry.config.isLocal).concat(prefixHits.filter(h => h.entry.config.isLocal));
      const h = ordered[0];
      return { client: h.entry.client, resolvedModel: h.matched || model, providerId: h.pid, isLocal: !!h.entry.config.isLocal, degraded: false };
    }`);

  // F. 第4步：模糊兜底 → 非本地优先
  s = s.replace(
`    // 4. 最后模糊匹配兜底
    for (const [, entry] of this.providers) {
      const matchedModel = entry.config.models.find(m => model.includes(m) || m.includes(model));
      if (matchedModel) {
        return { client: entry.client, resolvedModel: matchedModel };
      }
    }`,
`    // 4. 最后模糊匹配兜底（${MARK}：非本地优先）
    const fuzzyHits: { pid: string; entry: any; matchedModel: string }[] = [];
    for (const [pid, entry] of this.providers) {
      const mm = entry.config.models.find((m: string) => model.includes(m) || m.includes(model));
      if (mm) fuzzyHits.push({ pid, entry, matchedModel: mm });
    }
    if (fuzzyHits.length > 0) {
      const ordered = fuzzyHits.filter(h => !h.entry.config.isLocal).concat(fuzzyHits.filter(h => h.entry.config.isLocal));
      const h = ordered[0];
      return { client: h.entry.client, resolvedModel: h.matchedModel, providerId: h.pid, isLocal: !!h.entry.config.isLocal, degraded: false };
    }`);

  // G. NVIDIA fallback → degraded 标记 + error 级
  s = s.replace(
`        console.log(\`[AI Hub] 模型 "\${model}" 不可用，fallback 到 NVIDIA: \${fallbackModel}\`);
        return { client: entry.client, resolvedModel: fallbackModel };`,
`        console.error(\`[AI Hub][DEGRADED] 模型 "\${model}" 未命中任何 provider → 降级到 NVIDIA: \${fallbackModel}。请检查模型名与 *_API_KEY。\`);
        return { client: entry.client, resolvedModel: fallbackModel, providerId: 'nvidia-nim', isLocal: false, degraded: true };`);

  // H. ★本地 fallback → 响亮报错 + 开关可控
  s = s.replace(
`    for (const [, entry] of this.providers) {
      if (entry.config.isLocal && entry.config.models.length > 0) {
        const fallbackModel = entry.config.models[0];
        console.log(\`[AI Hub] 模型 "\${model}" 不可用，fallback 到本地: \${fallbackModel}\`);
        return { client: entry.client, resolvedModel: fallbackModel };
      }
    }`,
`    // ★ ${MARK} 核心护栏：静默降级到本地 = 速度掉 10~60 倍 + 任务超时，必须显形且可控
    const allowLocalFallback = String(process.env.LINGXI_ALLOW_LOCAL_FALLBACK || 'false').toLowerCase() !== 'false';
    for (const [pid, entry] of this.providers) {
      if (entry.config.isLocal && entry.config.models.length > 0) {
        // 优先选工具能力更好的本地模型，而非盲取 models[0]（可能是无关的转发壳/实验模型）
        const fallbackModel = entry.config.models.find((m: string) => /^(llama|qwen)/i.test(m)) || entry.config.models[0];
        const detail =
          \`[AI Hub][DEGRADED-TO-LOCAL] ✗✗ 模型 "\${model}" 未命中任何可用 provider，正降级到本地 (\${pid}) 的 "\${fallbackModel}"。\` +
          \`本地推理通常比云端慢 10~60 倍，极易触发 executor 超时（表现为「任务干到一半突然没了」）。\` +
          \`排查：① DEFAULT_MODEL / TOOL_MODEL / REPLY_MODEL 是否为真实云端模型名 \` +
          \`② 对应 *_API_KEY 是否已配置 ③ 模型名是否在 hub 的 provider models 清单内。\`;
        if (!allowLocalFallback) {
          console.error(detail + ' [LINGXI_ALLOW_LOCAL_FALLBACK=false → 拒绝降级，返回 null]');
          return null;
        }
        console.error(detail + ' [LINGXI_ALLOW_LOCAL_FALLBACK=true → 已放行，标记 degraded=true]');
        return { client: entry.client, resolvedModel: fallbackModel, providerId: pid, isLocal: true, degraded: true };
      }
    }`);

  // I. 终极兜底 → degraded 标记
  s = s.replace(
`    // 6. 最后兜底
    const first = this.providers.values().next().value;
    return first ? { client: first.client, resolvedModel: first.config.models[0] || model } : null;`,
`    // 6. 最后兜底（${MARK}：该路径同属降级，必须标记）
    const firstEntry: any = this.providers.entries().next().value;
    if (!firstEntry) return null;
    const firstFallback = firstEntry[1].config.models[0] || model;
    console.error(\`[AI Hub][DEGRADED] 模型 "\${model}" 无处可去 → 终极兜底 \${firstEntry[0]}/\${firstFallback}\`);
    return { client: firstEntry[1].client, resolvedModel: firstFallback, providerId: firstEntry[0], isLocal: !!firstEntry[1].config.isLocal, degraded: true };`);

  // J. getRoleClient 漂移检测升级为 error 级
  s = s.replace(
`    if (result && result.resolvedModel !== model) {
      console.warn(\`[AIHub] getRoleClient(\${role}): 请求 \${model} → 实际 \${result.resolvedModel} (模型名不匹配，可能是 provider 未配置 API Key 或模型名不在列表中)\`);
    } else if (!result) {`,
`    if (result && (result.resolvedModel !== model || result.degraded || result.isLocal)) {
      // ${MARK}：模型归属漂移必须 error 级可见（此前只有一行 warn，前端零感知）
      const tag = result.isLocal ? 'LOCAL!' : result.degraded ? 'DEGRADED' : 'RENAMED';
      console.error(
        \`[AIHub][MODEL-DRIFT][\${tag}] getRoleClient(\${role}): 请求 \${model} → 实际 \${result.resolvedModel}\` +
        \` @ \${result.providerId || '?'} (isLocal=\${!!result.isLocal}, degraded=\${!!result.degraded})\`
      );
    } else if (!result) {`);

  must(s !== B0, 'hub: 已应用修改');
  must(s.includes(MARK), 'hub: 标记写入');
  must(!s.includes('console.log(`[AI Hub] 模型 "${model}" 不可用，fallback 到本地'), 'hub: 旧静默日志已移除');
  // 幂等/安全：所有 providers 迭代都保留
  must((s.match(/for \(const \[/g) || []).length >= 6, 'hub: providers 迭代完整');
  writeBack(HUB, s, hub.crlf);
  total++;
  log.push(`  ✓ hub.ts 写回 (${fs.statSync(HUB).size} B)`);
}

// ══════════════════════════════════════════
// 2. router.ts — 模型归属可见化
// ══════════════════════════════════════════
const rt = readNorm(ROUTER);
let r = rt.src;
if (r.includes('Router][MODEL]')) {
  log.push('  - router.ts 已打过，跳过');
} else {
  must(r.includes("    let replyClient = this.aiHub.getRoleClient('reply') || clientResult;"), 'router: 定位角色路由');
  const B1 = r;
  r = r.replace(
`    let replyClient = this.aiHub.getRoleClient('reply') || clientResult;`,
`    let replyClient = this.aiHub.getRoleClient('reply') || clientResult;
    // ★ ${MARK} 模型归属可见化：\`请求 A 实际跑 B\`（尤其静默落到本地）必须一眼可见
    {
      const _tagOf = (c: any) => \`\${c?.resolvedModel || '?'}\${c?.isLocal ? '[LOCAL!]' : c?.degraded ? '[DEGRADED]' : ''}\`;
      const _drift: string[] = [];
      if (toolClient.resolvedModel !== requestedModel) _drift.push(\`tool:\${requestedModel || '(empty)'}→\${toolClient.resolvedModel}\`);
      if (replyClient.resolvedModel !== requestedModel) _drift.push(\`reply:\${requestedModel || '(empty)'}→\${replyClient.resolvedModel}\`);
      const _line = \`[Router][MODEL] agent=\${agent.displayName} req=\${requestedModel || '(empty)'} tool=\${_tagOf(toolClient)} reply=\${_tagOf(replyClient)} provider=\${(clientResult as any).providerId || '?'}\`;
      if ((toolClient as any).isLocal || (replyClient as any).isLocal || (clientResult as any).isLocal) {
        console.error(\`\${_line} ⚠️ 本地模型已接管（速度可能下降数十倍）\${_drift.length ? ' drift=' + _drift.join(',') : ''}\`);
      } else if (_drift.length) {
        console.warn(\`\${_line} drift=\${_drift.join(',')}\`);
      } else {
        console.log(_line);
      }
    }`);
  must(r !== B1, 'router: 已应用修改');
  writeBack(ROUTER, r, rt.crlf);
  total++;
  log.push(`  ✓ router.ts 写回 (${fs.statSync(ROUTER).size} B)`);
}

// ══════════════════════════════════════════
// 3. .env — DEFAULT_MODEL 修正 + 护栏开关
// ══════════════════════════════════════════
const ev = readNorm(ENV);
let e = ev.src;
if (e.includes('patch-v20')) {
  log.push('  - .env 已打过，跳过');
} else {
  must(/^DEFAULT_MODEL=glm-5\.2:cloud\s*$/m.test(e), '.env: 定位 DEFAULT_MODEL=glm-5.2:cloud');
  e = e.replace(/^DEFAULT_MODEL=glm-5\.2:cloud\s*$/m,
`# ${MARK}: glm-5.2:cloud 是 Ollama 云端转发壳（remote_host=ollama.com），
# 与 zhipu provider 的 "glm-5.2" 撞名，会被 local-ollama 抢先命中；
# 且它一旦不可用，旧逻辑会 fallback 到 models[0]（本机 CPU 模型）→ 慢数十倍 → 任务超时。
# 改用确定性云端模型（与 TOOL_MODEL / REPLY_MODEL 对齐）：
DEFAULT_MODEL=deepseek-flash
# 如需恢复原值，取消下一行注释（不建议，除非你确认 ollama.com 侧可用）：
# DEFAULT_MODEL=glm-5.2:cloud`);

  e = e.replace(/\s*$/, `\n\n# ${MARK}: 是否允许「静默降级到本地 Ollama」。false = 拒绝降级并响亮报错（推荐）
LINGXI_ALLOW_LOCAL_FALLBACK=false
# ${MARK}: :cloud 后缀名只命中本地 provider 时，若规范化名在云 provider 存在则改走云端
LINGXI_CLOUD_SUFFIX_STRICT=true
`);
  must(e.includes('DEFAULT_MODEL=deepseek-flash'), '.env: DEFAULT_MODEL 已修正');
  must(e.includes('LINGXI_ALLOW_LOCAL_FALLBACK=false'), '.env: 护栏开关已写入');
  writeBack(ENV, e, ev.crlf);
  total++;
  log.push(`  ✓ .env 写回 (${fs.statSync(ENV).size} B)`);
}

console.log(`[patch-v20] 完成，改动文件数 = ${total}`);
log.forEach(l => console.log(l));
console.log('\n下一步：npx tsc --noEmit');
