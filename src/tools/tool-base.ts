/**
 * tool-base.ts - ITool 接口 + ToolBase 抽象基类（受控工具调用路径）
 *
 * 统一实现 ITool 三段式骨架：
 *   validate → dryRun → execute
 *
 * 设计约定（与 ToolRegistry.registerToolInstance 配套）：
 *   - validate(input): 返回错误列表（空 = 通过）；registry 执行前自动调用，失败抛错
 *   - dryRun(input, ctx): 无副作用预演，返回元数据/预览
 *   - execute(args, ctx): 真正执行；ctx 为注册时通过 binding.context 绑定的上下文
 *
 * 注意：registry.execute 走实例路径时不会自动调用 dryRun；
 *       dryRun 仅供调用方（审批/审计/预览 UI）显式调用。
 */

export interface ITool {
  /** 工具名（与 ToolDefinition.name 一致） */
  name: string;
  /** 校验入参，返回错误列表（空 = 通过） */
  validate(input: unknown): string[];
  /** 无副作用预演 */
  dryRun(input: unknown, ctx?: unknown): unknown;
  /** 执行（args 为 AI 传入参数，ctx 为注册时绑定的上下文） */
  execute(args: Record<string, any>, ctx?: unknown): Promise<any>;
}

/** ToolBase 的可选构造配置 */
export interface ToolBaseOptions {
  name?: string;
  permissions?: string[];
}

export abstract class ToolBase implements ITool {
  /** 工具名（子类可用静态 name 覆写，或通过构造参数注入） */
  name: string;

  /** 执行所需权限（审计/审批用，可选） */
  permissions: string[];

  constructor(options: ToolBaseOptions = {}) {
    // 优先取子类静态声明的 name，其次构造参数，最后类名
    const staticName = (this.constructor as any).toolName;
    this.name = staticName || options.name || this.constructor.name;
    this.permissions = options.permissions ?? [];
  }

  /** 校验入参，返回错误列表（空 = 通过）。子类必须实现 */
  abstract validate(input: unknown): string[];

  /** 无副作用预演。子类必须实现（不得产生真实副作用） */
  abstract dryRun(input: unknown, ctx?: unknown): unknown;

  /** 执行。子类必须实现 */
  abstract execute(args: Record<string, any>, ctx?: unknown): Promise<any>;

  /** 执行出错钩子（默认打日志，子类可覆写做错误分类） */
  protected onExecuteError(err: unknown, args: Record<string, any>): void {
    console.error(`[${this.name}] 执行失败:`, (err as Error)?.message ?? err);
    void args;
  }

  /** 统一执行入口：带错误钩子的 execute 包装 */
  async run(args: Record<string, any>, ctx?: unknown): Promise<any> {
    try {
      return await this.execute(args, ctx);
    } catch (err) {
      this.onExecuteError(err, args);
      throw err;
    }
  }
}