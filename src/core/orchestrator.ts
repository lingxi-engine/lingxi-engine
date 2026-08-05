/**
 * Orchestrator — DAG 子程序编排引擎 v1.6.0
 *
 * 支持任务依赖图（DAG）、并行执行（最多3并发）、依赖等待、级联失败、死锁检测。
 */

export interface TaskNode {
  id: string;
  name: string;
  prompt: string;
  dependsOn: string[];    // 依赖的任务 ID 列表
  timeout?: number;       // 超时（ms），默认 60000
}

export interface TaskResult {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface OrchestratorResult {
  results: Map<string, TaskResult>;
  success: boolean;
  failedCount: number;
  duration: number;
}

const MAX_CONCURRENT = parseInt(process.env.ORCHESTRATOR_MAX_CONCURRENT || '5', 10);
const DEFAULT_TIMEOUT = 60_000;

export class Orchestrator {
  private tasks: Map<string, TaskNode> = new Map();
  private results: Map<string, TaskResult> = new Map();
  private executor: (task: TaskNode, context: Record<string, string>) => Promise<string>;

  constructor(executor: (task: TaskNode, context: Record<string, string>) => Promise<string>) {
    this.executor = executor;
  }

  /** 添加任务 */
  addTask(task: TaskNode): void {
    this.tasks.set(task.id, task);
    this.results.set(task.id, { id: task.id, status: 'pending' });
  }

  /** 执行全部任务 */
  async run(): Promise<OrchestratorResult> {
    const startTime = Date.now();

    // 1. 检测循环依赖（死锁）
    if (this.hasCycle()) {
      throw new Error('检测到循环依赖，无法编排');
    }

    // 2. 拓扑排序 + 并行执行
    const completed = new Set<string>();
    const failed = new Set<string>();
    let running = 0;

    return new Promise((resolve) => {
      const checkComplete = () => {
        let allDone = true;
        for (const [id, result] of this.results) {
          if (result.status === 'pending' || result.status === 'running') {
            allDone = false;
            break;
          }
        }
        if (allDone) {
          const failedCount = Array.from(this.results.values()).filter(r => r.status === 'failed').length;
          resolve({
            results: this.results,
            success: failedCount === 0,
            failedCount,
            duration: Date.now() - startTime,
          });
        }
      };

      const tryStart = () => {
        for (const [id, task] of this.tasks) {
          const result = this.results.get(id)!;
          if (result.status !== 'pending') continue;
          if (running >= MAX_CONCURRENT) break;

          // 检查依赖
          const depsOk = task.dependsOn.every(dep => completed.has(dep));
          const depsFailed = task.dependsOn.some(dep => failed.has(dep));

          if (depsFailed) {
            // 依赖失败 → 跳过此任务，并标记为失败让下游级联跳过
            result.status = 'skipped';
            result.error = '依赖任务失败';
            failed.add(id);
            checkComplete();
            continue;
          }

          if (!depsOk) continue;

          // 启动任务
          result.status = 'running';
          result.startedAt = Date.now();
          running++;

          // 构建上下文（已完成任务的输出）
          const context: Record<string, string> = {};
          for (const dep of task.dependsOn) {
            const depResult = this.results.get(dep);
            if (depResult?.output) context[dep] = depResult.output;
          }

          const timeout = task.timeout || DEFAULT_TIMEOUT;
          const timeoutId = setTimeout(() => {
            if (result.status === 'running') {
              result.status = 'failed';
              result.error = '超时';
              result.finishedAt = Date.now();
              failed.add(id);
              running--;
              tryStart();
            }
          }, timeout);

          this.executor(task, context)
            .then(output => {
              clearTimeout(timeoutId);
              result.status = 'done';
              result.output = output;
              result.finishedAt = Date.now();
              completed.add(id);
              running--;
              tryStart();
              checkComplete();
            })
            .catch(err => {
              clearTimeout(timeoutId);
              result.status = 'failed';
              result.error = err.message || String(err);
              result.finishedAt = Date.now();
              failed.add(id);
              running--;
              tryStart();
              checkComplete();
            });
        }
        checkComplete();
      };

      tryStart();
      // 安全修复 P2#24：watchdog 兜底——running=0 但有 pending 时重试 tryStart，防死锁
      const wd = setInterval(() => {
        let pending = 0;
        for (const [, r] of this.results) if (r.status === 'pending' || r.status === 'running') pending++;
        if (pending === 0) { clearInterval(wd); return; }
        if (running === 0) tryStart();
      }, 1000);
      if (wd.unref) wd.unref();
    });
  }

  /** 检测循环依赖 */
  private hasCycle(): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string): boolean => {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      stack.add(id);
      const task = this.tasks.get(id);
      if (task) {
        for (const dep of task.dependsOn) {
          if (dfs(dep)) return true;
        }
      }
      stack.delete(id);
      return false;
    };

    for (const id of this.tasks.keys()) {
      if (dfs(id)) return true;
    }
    return false;
  }

  /** 获取结果 */
  getResults(): TaskResult[] {
    return Array.from(this.results.values());
  }
}