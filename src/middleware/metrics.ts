/**
 * metrics.ts — 轻量 Prometheus 风格指标（无外部依赖）
 *
 * 提供：
 *  - 计数器 / 直方图式累计（请求数、token 数、耗时）
 *  - GET /metrics 输出 text/plain; version=0.0.4 格式
 *  - 中间件 metricsMiddleware 自动记录 http 请求
 *
 * 环境变量：METRICS_ENABLED=false 可关闭（默认开启，但 /metrics 路由需 admin 或本机来源）
 */

interface Counter { value: number }
interface Histogram { count: number; sum: number }

const counters: Record<string, Counter> = {};
const histograms: Record<string, Histogram> = {};
const gauges: Record<string, number> = {};

export function inc(name: string, labels?: Record<string, string>, by = 1): void {
  const key = withLabels(name, labels);
  (counters[key] = counters[key] || { value: 0 }).value += by;
}

export function observe(name: string, value: number, labels?: Record<string, string>): void {
  const key = withLabels(name, labels);
  const h = (histograms[key] = histograms[key] || { count: 0, sum: 0 });
  h.count += 1;
  h.sum += value;
}

export function setGauge(name: string, value: number): void {
  gauges[name] = value;
}

function withLabels(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  return `${name}{${parts}}`;
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
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

/** Express 中间件：记录 http 请求耗时与状态码 */
export function metricsMiddleware() {
  return (req: any, res: any, next: any) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = (req.route && req.route.path) ? `${req.baseUrl || ''}${req.route.path}` : (req.path || 'unknown');
      inc('lingxi_http_requests_total', { method: req.method, route, status: String(res.statusCode) });
      observe('lingxi_http_request_duration_ms', ms, { method: req.method, route });
    });
    next();
  };
}
