import { ToolBase } from './tool-base.js';
import { runToolsLoop, RunToolsOptions, RunToolsResult } from './executor.js';

/**
 * ExecutorTool wraps the existing runToolsLoop into an ITool implementation.
 * This allows the runtime to treat the executor as a first-class tool instance
 * (supporting dryRun, permission checks, abort/timeout, and audit).
 */

/** Error classification for executor failures */
export type ExecutorErrorKind = 'validation' | 'timeout' | 'aborted' | 'runtime' | 'unknown';

export class ExecutorError extends Error {
  kind: ExecutorErrorKind;
  cause?: Error;
  constructor(kind: ExecutorErrorKind, message: string, cause?: Error) {
    super(message);
    this.name = 'ExecutorError';
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

export class ExecutorTool extends ToolBase<Record<string, any>, RunToolsResult> {
  name = 'executor';
  permissions = ['tool:execute'];

  /** Default timeout: 120s (overridden by input.timeoutMs or opts.timeoutMs) */
  private defaultTimeoutMs = 120_000;

  validate(input: Record<string, any>): boolean {
    if (!input) return false;
    if (!input.client) return false;
    if (typeof input.model !== 'string' || input.model.length === 0) return false;
    if (!Array.isArray(input.messages)) return false;
    if (!input.registry) return false;
    if (!input.agentId) return false;
    return true;
  }

  async dryRun(input: Record<string, any>): Promise<RunToolsResult> {
    const ok = this.validate(input);
    if (!ok) {
      return {
        finalContent: '[dry-run] invalid executor input',
        messages: [],
        toolResults: [],
        iterations: 0,
        aborted: true,
      };
    }
    // Preview what tools would be available
    const registry = input.registry;
    let toolPreview = '';
    try {
      const tools = registry.listToolsForAgent?.(input.agentId) || registry.listTools?.() || [];
      toolPreview = ` (${tools.length} tools available)`;
    } catch { /* ignore */ }

    return {
      finalContent: `[dry-run] executor validated inputs successfully${toolPreview} (no execution)`,
      messages: [],
      toolResults: [],
      iterations: 0,
      aborted: false,
    };
  }

  async execute(input: Record<string, any>, opts?: { timeoutMs?: number }): Promise<RunToolsResult> {
    // ── Validate ──
    if (!this.validate(input)) {
      throw new ExecutorError('validation', 'ExecutorTool: invalid input');
    }

    // ── Build AbortSignal with timeout ──
    const timeoutMs = opts?.timeoutMs || input.timeoutMs || this.defaultTimeoutMs;
    const existingSignal = input.signal as AbortSignal | undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // If caller provided an external signal, propagate its abort
    if (existingSignal) {
      if (existingSignal.aborted) {
        clearTimeout(timer);
        throw new ExecutorError('aborted', 'ExecutorTool: external signal already aborted');
      }
      existingSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // ── Map input → RunToolsOptions ──
    const runOpts: RunToolsOptions = {
      client: input.client,
      model: input.model,
      messages: input.messages,
      registry: input.registry,
      agentId: input.agentId,
      chatId: input.chatId,
      maxIterations: input.maxIterations,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      signal: controller.signal,
      summaryModel: input.summaryModel,
      forceComplete: input.forceComplete,
      requireCompletion: input.requireCompletion,
      onToolCall: input.onToolCall,
      onToolResult: input.onToolResult,
      onThink: input.onThink,
    } as RunToolsOptions;

    // ── Execute with error classification ──
    try {
      const res = await runToolsLoop(runOpts);
      return res;
    } catch (err: any) {
      // Classify the error
      if (controller.signal.aborted) {
        // Distinguish timeout vs external abort
        if (existingSignal?.aborted) {
          throw new ExecutorError('aborted', `ExecutorTool: aborted by external signal — ${err?.message || ''}`, err);
        }
        throw new ExecutorError('timeout', `ExecutorTool: timed out after ${timeoutMs}ms — ${err?.message || ''}`, err);
      }
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw new ExecutorError('aborted', `ExecutorTool: aborted — ${err?.message || ''}`, err);
      }
      // Generic runtime error
      throw new ExecutorError('runtime', `ExecutorTool: execution failed — ${err?.message || String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}