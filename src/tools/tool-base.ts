export interface ITool<I = any, O = any> {
  name: string;
  /** Permissions required to execute this tool (e.g. ["file:write", "network:http"]) */
  permissions?: string[];
  /** Validate input shape; throw or return false on invalid */
  validate?(input: I): boolean | Promise<boolean>;
  /** Dry-run the tool without performing side effects (should be safe) */
  dryRun?(input: I): Promise<O> | O;
  /** Execute the tool; should enforce timeouts / sandbox boundaries upstream */
  execute(input: I, opts?: { timeoutMs?: number }): Promise<O>;
}

/**
 * Optional abstract base class providing a small default wrapper around ITool.
 * Concrete tools can extend this to get a consistent shape and helper for
 * wiring permission checks and dry-run behavior.
 */
export abstract class ToolBase<I = any, O = any> implements ITool<I, O> {
  abstract name: string;
  permissions?: string[] = [];

  validate?(input: I): boolean | Promise<boolean> {
    return true;
  }

  async dryRun?(input: I): Promise<O> {
    // Default dryRun delegates to execute but should be overridden for safety.
    // Implementations are encouraged to avoid side effects here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.execute((input as any) as I, { timeoutMs: 2000 });
  }

  abstract execute(input: I, opts?: { timeoutMs?: number }): Promise<O>;
}
