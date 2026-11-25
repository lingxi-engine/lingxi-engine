/**
 * 模型健康探针与短期健康缓存（v2.0.46）
 *
 * 背景：存在「目录在列、推理无响应」的幽灵模型（实测案例：2026-11 NVIDIA NIM 的
 * moonshotai/kimi-k3.1-pro —— /v1/models 在列，但 chat completions 240s 零字节，
 * 连响应头都不返回）。这类模型不产生 HTTP 错误状态，熔断器（需连续 5 次失败）
 * 来不及拦截，单次请求会一直挂到客户端超时，拖死任务路由。
 *
 * 本模块提供：
 *  1) ModelHealthCache —— 基于 TTL 的不健康标记，供同步路由决策（故障转移候选过滤、快速失败）；
 *  2) probeModelHealth —— 1-token 请求 + AbortController 短超时的主动探针；
 *  3) isTimeoutLikeError —— 识别超时/连接类错误（区别于 4xx 配置类错误）。
 *
 * 语义约定（与熔断器保持一致）：
 *  - 429 限流是临时状态，不标记不健康；
 *  - 探针成功立即清除标记（模型恢复即放行）；
 *  - 标记默认 10 分钟过期，过期自动放行重试。
 */
import type OpenAI from "openai";

export interface ProbeResult {
  healthy: boolean;
  latencyMs: number;
  timedOut?: boolean;
  error?: string;
  status?: number;
}

export interface UnhealthyMark {
  model: string;
  reason: string;
  until: number;
}

export const DEFAULT_UNHEALTHY_TTL_MS = 10 * 60_000;

export class ModelHealthCache {
  private marks = new Map<string, { until: number; reason: string }>();

  constructor(private readonly defaultTtlMs: number = DEFAULT_UNHEALTHY_TTL_MS) {}

  markUnhealthy(model: string, reason: string, ttlMs?: number): void {
    if (!model) return;
    const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : this.defaultTtlMs;
    this.marks.set(model, { until: Date.now() + ttl, reason: reason || "unknown" });
  }

  markHealthy(model: string): void {
    this.marks.delete(model);
  }

  isUnhealthy(model: string): boolean {
    const m = this.marks.get(model);
    if (!m) return false;
    if (Date.now() >= m.until) {
      this.marks.delete(model);
      return false;
    }
    return true;
  }

  getMark(model: string): UnhealthyMark | null {
    if (!this.isUnhealthy(model)) return null;
    const m = this.marks.get(model)!;
    return { model, reason: m.reason, until: m.until };
  }

  listUnhealthy(): UnhealthyMark[] {
    const out: UnhealthyMark[] = [];
    for (const model of [...this.marks.keys()]) {
      const mark = this.getMark(model);
      if (mark) out.push(mark);
    }
    return out;
  }

  clear(): void {
    this.marks.clear();
  }
}

/** 判断错误是否属于超时/连接类（无 HTTP 状态的纯挂死、网络中断等） */
export function isTimeoutLikeError(err: any): boolean {
  if (!err) return false;
  const name = String(err.name || "");
  const msg = String(err.message || "").toLowerCase();
  const code = String(err.code || "").toUpperCase();
  if (name === "AbortError" || name === "APIConnectionTimeoutError" || name === "TimeoutError") return true;
  if (["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  return /timeout|timed out|socket hang up|aborted|fetch failed/.test(msg);
}

export interface ProbeOptions {
  /** 探针超时（毫秒），默认 8000 */
  timeoutMs?: number;
  /** 探针结果写入的健康缓存 */
  cache?: ModelHealthCache;
  /** 探针失败时标记的 TTL（毫秒），默认走缓存自身默认值 */
  unhealthyTtlMs?: number;
}

/**
 * 主动探针：向模型发一条 1-token 级请求，短超时内无响应即判不健康。
 * 注意：依赖 OpenAI SDK  honoring AbortSignal（v4 支持 request options.signal）。
 */
export async function probeModelHealth(
  client: OpenAI,
  model: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        temperature: 0,
      },
      { signal: controller.signal as any },
    );
    const latencyMs = Date.now() - start;
    opts.cache?.markHealthy(model);
    return { healthy: true, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const timedOut = controller.signal.aborted || isTimeoutLikeError(err);
    const status = typeof err?.status === "number" ? err.status : undefined;
    const result: ProbeResult = {
      healthy: false,
      latencyMs,
      timedOut,
      error: String(err?.message || err),
      status,
    };
    // 429 限流是临时状态：不标记不健康（与熔断器语义一致）
    if (status !== 429) {
      opts.cache?.markUnhealthy(model, result.error || "probe failed", opts.unhealthyTtlMs);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
