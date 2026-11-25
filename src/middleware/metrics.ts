/**
 * metrics.ts — 轻量 Prometheus 风格指标（无外部依赖）
 *
 * 提供：
 *  - 计数器 / 直方图式累计（请求数、token 数、耗时）
 *  - GET /metrics 输出 text/plain; version=0.0.4 格式
 *  - 中间件 metricsMiddleware 自动记录 http 请求
 *
 * 环境变量：METRICS_ENABLED=false 可关闭（默认开启，但 /metrics 路由需 admin 或本机来源）
 *
 * v2.0.42 接线修复：本模块此前是死代码（index.ts 从未挂载中间件、从未暴露 /metrics）。
 * 现已在 index.ts 挂载 metricsMiddleware() 并注册受保护的 GET /metrics。
 * 同时新增路由标签归一化（数字/UUID/长十六进制段 → :id），防止 Prometheus 标签基数爆炸。
 *
 * v2.0.44 审计加固：序列数上限（MAX_SERIES_PER_METRIC）。
 * 归一化只覆盖数字/UUID/长十六进制段；攻击者用随机字母路径扫 404 时，
 * 每个路径仍会产生一条新时间序列 → 内存无限增长。现在每个指标名下的
 * 不同标签组合数达到上限后，新序列一律折叠进 route="(overflow)"，
 * 既有正常序列不受影响、继续累计。
 */

interface Counter { value: number }
interface Histogram { count: number; sum: number }

const counters: Record<string, Counter> = {};
const histograms: Record<string, Histogram> = {};
const gauges: Record<string, number> = {};

/** 每个指标名允许的最大标签组合（时间序列）数；超出折叠进 overflow。 */
const MAX_SERIES_PER_METRIC = 512;
const seriesCount: Record<string, number> = {};

/**
 * 基数护栏：已存在的序列直接复用；新序列在上限内正常创建；
 * 超限后把 route 标签改写为 '(overflow)' 折叠（保留 method/status 等其它标签）。
 */
function boundedKey(name: string, labels: Record<string, string> | undefined, store: Record<string, unknown>): string {
  const key = withLabels(name, labels);
  if (store[key]) return key;
  const n = seriesCount[name] || 0;
  if (n < MAX_SERIES_PER_METRIC) {
    seriesCount[name] = n + 1;
    return key;
  }
  const folded = withLabels(name, { ...(labels || {}), route: '(overflow)' });
  if (!store[folded]) seriesCount[name] = n + 1;
  return folded;
}

export function inc(name: string, labels?: Record<string, string>, by = 1): void {
  const key = boundedKey(name, labels, counters);
  (counters[key] = counters[key] || { value: 0 }).value += by;
}

export function observe(name: string, value: number, labels?: Record<string, string>): void {
  const key = boundedKey(name, labels, histograms);
  const h = (histograms[key] = histograms[key] || { count: 0, sum: 0 });
  h.count += 1;
  h.sum += value;
}

export function setGauge(name: string, value: number): void {
  gauges[name] = value;
}

/** 仅供测试：清空全部指标，保证用例间隔离 */
export function resetMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(histograms)) delete histograms[k];
  for (const k of Object.keys(gauges)) delete gauges[k];
  for (const k of Object.keys(seriesCount)) delete seriesCount[k];
}

function withLabels(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  return `${name}{${parts}}`;
}

/**
 * 路由归一化：把路径中的动态段替换为 :id，避免每个会话/用户 ID 都产生一条新时间序列。
 * 覆盖：纯数字段、UUID、>=16 位十六进制串（numericId/token/实例 ID 等）。
 */
export function normalizeRoute(p: string): string {
  const s = String(p || 'unknown').split('?')[0].slice(0, 200);
  return s
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:id');
}

export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP lingxi_up 灵犀引擎进程是否存活（恒为 1）');
  lines.push('# TYPE lingxi_up gauge');
  lines.push('lingxi_up 1');
  lines.push(`# HELP process_uptime_seconds 进程运行秒数`);
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.floor(process.uptime())}`);

  for (const [key, c] of Object.entries(counters)) {
    const m = key.match(/^([^{]+)(\{.*\})?$/);
    const name = m ? m[1] : key;
    const lbl = m && m[2] ? m[2] : '';
    if (!lines.includes(`# TYPE ${name} counter`)) {
      lines.push(`# HELP ${name} counter`);
      lines.push(`# TYPE ${name} counter`);
    }
    lines.push(`${name}${lbl} ${c.value}`);
  }
  for (const [key, h] of Object.entries(histograms)) {
    const m = key.match(/^([^{]+)(\{.*\})?$/);
    const name = m ? m[1] : key;
    const lbl = m && m[2] ? m[2] : '';
    if (!lines.includes(`# TYPE ${name} summary`)) {
      lines.push(`# HELP ${name} summary`);
      lines.push(`# TYPE ${name} summary`);
    }
    lines.push(`${name}_count${lbl} ${h.count}`);
    lines.push(`${name}_sum${lbl} ${h.sum}`);
  }
  for (const [name, v] of Object.entries(gauges)) {
    if (!lines.includes(`# TYPE ${name} gauge`)) {
      lines.push(`# HELP ${name} gauge`);
      lines.push(`# TYPE ${name} gauge`);
    }
    lines.push(`${name} ${v}`);
  }
  return lines.join('\n') + '\n';
}

/** Express 中间件：记录 http 请求耗时与状态码（METRICS_ENABLED=false 时零开销跳过） */
export function metricsMiddleware() {
  return (req: any, res: any, next: any) => {
    if (String(process.env.METRICS_ENABLED ?? 'true').toLowerCase() === 'false') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = (req.route && req.route.path)
        ? `${req.baseUrl || ''}${req.route.path}`
        : normalizeRoute(req.path);
      inc('lingxi_http_requests_total', { method: req.method, route, status: String(res.statusCode) });
      observe('lingxi_http_request_duration_ms', ms, { method: req.method, route });
    });
    next();
  };
}
