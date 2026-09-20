/**
 * 回归测试：Orchestrator 级联失败死锁（v28 修复验证）
 * 场景：A -> B -> C 链，A 失败（用户停止/超时），验证 B、C 被级联 skip 而非永久 pending。
 * 修复前：B 被 skip 但不入 failed 集合，C 依赖 B 时 depsOk=false 且 depsFailed=false，永久 pending，run() 永不 resolve。
 */
import { Orchestrator } from '../src/core/orchestrator';

async function scenario(name: string, failTask: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  const o = new Orchestrator(async (task) => {
    if (task.id === failTask) {
      throw new Error('模拟失败：' + task.id);
    }
    await new Promise(r => setTimeout(r, 20));
    return 'output-of-' + task.id;
  });
  o.addTask({ id: 'A', name: 'A', prompt: 'A', dependsOn: [] });
  o.addTask({ id: 'B', name: 'B', prompt: 'B', dependsOn: ['A'] });
  o.addTask({ id: 'C', name: 'C', prompt: 'C', dependsOn: ['B'] });

  const result = await Promise.race([
    o.run(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('DEADLOCK: run() 未在 ' + timeoutMs + 'ms 内 resolve')), timeoutMs)),
  ]) as any;

  const statuses = result.results ? Object.fromEntries([...result.results.entries()].map(([id, r]: [string, any]) => [id, r.status])) : {};
  const ok = statuses['A'] === 'failed' && statuses['B'] === 'skipped' && statuses['C'] === 'skipped' && result.success === false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}  statuses=${JSON.stringify(statuses)} success=${result.success} failedCount=${result.failedCount} took=${Date.now() - t0}ms`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  await scenario('级联跳过 A失败', 'A', 3000);
  console.log('done');
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(1); });
