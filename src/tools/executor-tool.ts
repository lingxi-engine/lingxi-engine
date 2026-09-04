import { ToolBase } from './tool-base.js';
import { runToolsLoop, RunToolsOptions, RunToolsResult } from './executor.js';

/**
 * ExecutorTool wraps the existing runToolsLoop into an ITool implementation.
 * This allows the runtime to treat the executor as a first-class tool instance
 * (supporting dryRun, permission checks, etc.).
 */
export class ExecutorTool extends ToolBase<Record<string, any>, RunToolsResult> {
  name = 'executor';
  permissions = ['tool:execute'];

  validate(input: Record<string, any>): boolean {
    // Basic sanity checks for required fields. More advanced validation can be
    // implemented in dryRun or by the registry before approval.
    if (!input) return false;
    if (!input.client) return false;
    if (typeof input.model !== 'string' || input.model.length === 0) return false;
    if (!Array.isArray(input.messages)) return false;
    if (!input.registry) return false;
    if (!input.agentId) return false;
    return true;
  }

  async dryRun(input: Record<string, any>): Promise<RunToolsResult> {
    // Perform a non-destructive validation pass. Do NOT execute external
    // side-effects here. Return a lightweight RunToolsResult suitable for
    // previews and auditing.
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
    return {
      finalContent: '[dry-run] executor validated inputs successfully (no execution)',
      messages: [],
      toolResults: [],
      iterations: 0,
      aborted: false,
    };
  }

  async execute(input: Record<string, any>): Promise<RunToolsResult> {
    if (!this.validate(input)) {
      throw new Error('ExecutorTool: invalid input');
    }
    // Map the generic input into RunToolsOptions expected by runToolsLoop.
    const opts: RunToolsOptions = {
      client: input.client,
      model: input.model,
      messages: input.messages,
      registry: input.registry,
      agentId: input.agentId,
      chatId: input.chatId,
      maxIterations: input.maxIterations,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      signal: input.signal,
      summaryModel: input.summaryModel,
      forceComplete: input.forceComplete,
      requireCompletion: input.requireCompletion,
      onToolCall: input.onToolCall,
      onToolResult: input.onToolResult,
      onThink: input.onThink,
    } as RunToolsOptions;

    // Delegate to the original runToolsLoop implementation.
    const res = await runToolsLoop(opts);
    return res;
  }
}
