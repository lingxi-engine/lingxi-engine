import { ExecutorTool } from '../tools/executor-tool.js';
import { InMemoryVectorStore } from '../memory/vector-store.js';

// Minimal fake client that simulates chat.completions.create
const fakeClient = {
  chat: {
    completions: {
      async create(params: any) {
        return {
          choices: [{ message: { role: 'assistant', content: '任务完成' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    },
  },
};

// Minimal registry stub with the methods runToolsLoop expects
const dummyRegistry = {
  listToolsForAgent: (_agentId: string) => [],
  getTool: (_name: string) => undefined,
  execute: async (_args: any) => ({ callId: 'x', toolName: 'x', success: true, result: null, durationMs: 0 }),
};

// Simple test harness without a test runner (vitest will import this)
export async function runExecutorToolSmoke() {
  const tool = new ExecutorTool();
  const inMemory = new InMemoryVectorStore();
  await inMemory.init?.();

  const input = {
    client: fakeClient,
    model: 'gpt-test',
    messages: [{ role: 'user', content: '请完成任务' }],
    registry: dummyRegistry,
    agentId: 'agent-test',
  };

  const dry = await tool.dryRun(input);
  if (dry.aborted) throw new Error('dryRun aborted unexpectedly');

  const res = await tool.execute(input);
  if (!res.finalContent || !res.finalContent.includes('完成')) throw new Error('unexpected executor result');
  return true;
}

// 直接运行时执行冒烟检查（tsx src/tests/executor-tool.smoke.ts）
if (process.argv[1] && process.argv[1].includes('executor-tool.smoke')) {
  runExecutorToolSmoke()
    .then(() => {
      console.log('[smoke] ExecutorTool 冒烟测试通过 (dryRun + execute 全链路)');
      process.exit(0);
    })
    .catch((e) => {
      console.error('[smoke] 冒烟测试失败:', e.message);
      process.exit(1);
    });
}