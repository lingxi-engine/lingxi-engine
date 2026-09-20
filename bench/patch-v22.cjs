/**
 * patch-v22.cjs — 区分「云端中继壳」与「真本机推理」+ 严格模型模式
 * 幂等。CRLF 安全。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HUB = path.join(ROOT, 'src', 'ai', 'hub.ts');
const ENV = path.join(ROOT, '.env');
const MARK = 'patch-v22:applied';

let total = 0;
const log = [];
function readNorm(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  return { src: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf };
}
function writeBack(p, s, crlf) { fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8'); }
function must(c, l) { if (!c) { console.error(`[patch-v22] ✗ 断言失败: ${l}`); process.exit(1); } log.push(`  ✓ ${l}`); }

const hub = readNorm(HUB);
let s = hub.src;
if (s.includes(MARK)) { log.push('  - hub.ts 已打过，跳过'); }
else {
  must(s.split('\n').filter(l => /^\s{2}getClient\(model: string\): AIResolvedClient \| null \{$/.test(l)).length === 1, 'hub: getClient 定义唯一');
  must(s.includes('  /** 注意：Ollama 转发壳（glm-5.2:cloud 等）也算 isLocal，因为它们经本机 daemon 转发 */\n  isLocal?: boolean;'), 'hub: 定位 AIResolvedClient');
  const B = s;

  // A. 类型扩展
  s = s.replace(
`  /** 注意：Ollama 转发壳（glm-5.2:cloud 等）也算 isLocal，因为它们经本机 daemon 转发 */
  isLocal?: boolean;`,
`  /** provider 是否为本机 daemon（注意：经本机转发的云端模型也会是 true，见 viaLocalDaemon） */
  isLocal?: boolean;
  /** ${MARK} true = 经本机 Ollama daemon 转发，但推理发生在远端（:cloud / -cloud 后缀） */
  viaLocalDaemon?: boolean;
  /** ${MARK} true = 推理真在本机 CPU/GPU 上跑（慢，是"跑到本地模型"的真正含义） */
  realLocal?: boolean;`);

  // B. getClient → getClientInner + 归一化包装
  s = s.replace('  getClient(model: string): AIResolvedClient | null {',
`  /**
   * ${MARK} 归一化包装：区分「本机 daemon 转发」与「真本机推理」，并支持严格模型模式。
   * 语义修正：glm-5.2:cloud / kimi-k2.7-code:cloud 等后缀是 Ollama 云端中继壳，
   * 推理在远端进行，不应等同于"跑到了本地模型"（旧代码把它们都标成 isLocal=true，误导排查）。
   */
  getClient(model: string): AIResolvedClient | null {
    return this.normalizeResolved(model, this.getClientInner(model));
  }

  private normalizeResolved(model: string, r: AIResolvedClient | null): AIResolvedClient | null {
    if (!r) return r;
    const strict = String(process.env.LINGXI_STRICT_MODEL || 'false').toLowerCase() !== 'false';
    if (r.degraded && strict && model && model.trim()) {
      console.error(\`[AI Hub][STRICT] 模型 "\${model}" 未命中且 LINGXI_STRICT_MODEL=true → 拒绝静默替换，返回 null\`);
      return null;
    }
    const shell = /:(cloud|remote)$|-cloud$/i.test(r.resolvedModel);
    if (shell) return { ...r, isLocal: false, viaLocalDaemon: true, realLocal: false };
    return { ...r, realLocal: !!r.isLocal };
  }

  private getClientInner(model: string): AIResolvedClient | null {`);

  must(s !== B, 'hub: 已应用修改');
  must(s.includes(MARK), 'hub: 标记写入');
  writeBack(HUB, s, hub.crlf); total++;
  log.push(`  ✓ hub.ts 写回 (${fs.statSync(HUB).size} B)`);
}

const ev = readNorm(ENV);
let e = ev.src;
if (e.includes(MARK)) { log.push('  - .env 已打过，跳过'); }
else {
  e = e.replace(/\s*$/, `\n# ${MARK}: true = 请求的模型名未命中时直接报错，而不是静默替换成别的模型（严格模式）
LINGXI_STRICT_MODEL=false
`);
  must(e.includes('LINGXI_STRICT_MODEL=false'), '.env: 严格模式开关已写入');
  writeBack(ENV, e, ev.crlf); total++;
  log.push(`  ✓ .env 写回 (${fs.statSync(ENV).size} B)`);
}

console.log(`[patch-v22] 完成，改动文件数 = ${total}`);
log.forEach(l => console.log(l));
