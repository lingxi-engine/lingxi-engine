/**
 * 验证 hub.ts provider 级故障转移
 * 场景：
 *  1. 主 provider 抛 402 → 自动切到备胎 provider 成功
 *  2. 主 provider 抛 5xx 重试耗尽 → 自动切到备胎
 *  3. 所有 provider 都失败 → 抛错
 *  4. 备胎熔断器开启中 → 跳过它
 *  5. 主 provider 正常 → 不触发故障转移
 *  6. getFailoverCandidates 候选正确性
 */
import { AIHub } from '../src/ai/hub.ts';

function makeHub() {
  const hub = new AIHub();
  hub.addProvider({
    id: 'test-main', type: 'custom', apiKey: 'fake-main',
    baseUrl: 'http://main.test/v1', models: ['model-alpha'], isLocal: false,
  });
  hub.addProvider({
    id: 'test-fallback', type: 'custom', apiKey: 'fake-fallback',
    baseUrl: 'http://fallback.test/v1', models: ['model-alpha'], isLocal: false,
  });
  return hub;
}

function mockClient(hub: any, providerId: string, impl: (model: string) => Promise<any>) {
  const entry = hub.providers.get(providerId);
  if (!entry) throw new Error(`provider ${providerId} 不存在`);
  entry.client.chat.completions.create = async (opts: any) => impl(opts.model);
}

function okResponse(model: string) {
  return {
    choices: [{ message: { content: `ok-from-${model}` } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

let passed = 0, failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail ? '— ' + detail : ''}`); }
}

async function main() {
  console.log('场景1: 主 provider 402 → 故障转移到备胎');
  {
    const hub = makeHub() as any;
    mockClient(hub, 'test-main', async () => {
      const e: any = new Error('Insufficient Balance');
      e.status = 402; throw e;
    });
    mockClient(hub, 'test-fallback', async (m) => okResponse(m));
    const r = await hub.generate({ model: 'model-alpha', messages: [{ role: 'user', content: 'hi' }] });
    assert('返回备胎模型内容', r.content === 'ok-from-model-alpha', r.content);
    assert('usage 正常', !!r.usage);
  }

  console.log('场景2: 主 provider 5xx 重试耗尽 → 故障转移');
  {
    const hub = makeHub() as any;
    mockClient(hub, 'test-main', async () => {
      const e: any = new Error('Service Unavailable');
      e.status = 500; throw e;
    });
    mockClient(hub, 'test-fallback', async (m) => okResponse(m));
    const r = await hub.generate({ model: 'model-alpha', messages: [{ role: 'user', content: 'hi' }] });
    assert('返回备胎模型内容', r.content === 'ok-from-model-alpha', r.content);
  }

  console.log('场景3: 所有 provider 都失败 → 抛错');
  {
    const hub = makeHub() as any;
    mockClient(hub, 'test-main', async () => {
      const e: any = new Error('Main Down'); e.status = 500; throw e;
    });
    mockClient(hub, 'test-fallback', async () => {
      const e: any = new Error('Fallback Down'); e.status = 500; throw e;
    });
    let threw = false;
    try {
      await hub.generate({ model: 'model-alpha', messages: [{ role: 'user', content: 'hi' }] });
    } catch (e: any) {
      threw = true;
      assert('错误信息含主模型或重试提示', /model-alpha|重试|失败/.test(e.message), e.message);
    }
    assert('最终抛错', threw);
  }

  console.log('场景4: 备胎自身熔断器开启中 → 跳过，仍抛错');
  {
    const hub = makeHub() as any;
    mockClient(hub, 'test-main', async () => {
      const e: any = new Error('Main Down'); e.status = 500; throw e;
    });
    hub.circuitBreaker.set('model-alpha', { failures: hub.CB_THRESHOLD, lastFail: Date.now() });
    let threw = false;
    try {
      await hub.generate({ model: 'model-alpha', messages: [{ role: 'user', content: 'hi' }] });
    } catch (e: any) {
      threw = true;
    }
    assert('跳过熔断中的备胎并抛错', threw);
  }

  console.log('场景5: 主 provider 正常 → 不触发故障转移');
  {
    const hub = makeHub() as any;
    let fallbackCalled = false;
    mockClient(hub, 'test-main', async (m) => okResponse(m));
    mockClient(hub, 'test-fallback', async (m) => { fallbackCalled = true; return okResponse(m); });
    const r = await hub.generate({ model: 'model-alpha', messages: [{ role: 'user', content: 'hi' }] });
    assert('主模型返回', r.content === 'ok-from-model-alpha');
    assert('备胎未被调用', !fallbackCalled);
  }

  console.log('场景6: getFailoverCandidates 候选正确性');
  {
    const hub = makeHub() as any;
    const cands = hub.getFailoverCandidates('model-alpha', 'http://main.test/v1');
    assert('排除主 provider 后剩 1 个候选', cands.length === 1, `实际 ${cands.length}`);
    assert('候选是 fallback provider', cands[0]?.client.baseURL === 'http://fallback.test/v1', cands[0]?.client.baseURL);
    const none = hub.getFailoverCandidates('no-such-model-xyz');
    assert('未知模型无候选', none.length === 0);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
