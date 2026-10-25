/**
 * 会话隔离 — 浏览器真实 E2E 测试
 *
 * 复现用户报告的 bug：会话 A 里发的消息，点进会话 B 也会显示。
 *
 * 做法：真实 Chromium 打开灵犀引擎页面，真实连上 WS，
 * 然后直接向页面的 handleMessage 注入服务端流式事件
 * （agent.streaming.start / chunk / end），
 * 验证：会话 A 的流式回复不会出现在会话 B 的消息区。
 *
 * 覆盖 4 个场景：
 *   1. 非当前会话的 streaming.start → 当前消息区不出现气泡
 *   2. 非当前会话的 streaming.chunk → 不出现气泡
 *   3. 切回会话 A → 历史里能看到 A 的消息（服务端已落库）
 *   4. 当前会话的 streaming.start → 正常出现气泡（没修过头）
 */

import puppeteer from 'puppeteer';

const BASE = 'http://127.0.0.1:3456';
const CHAT_A = 'chat-u-mvkwz00m-rkfb-mvnsl790'; // 「检查bug」
const CHAT_B = 'chat-u-mvl4n45p-6lct';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : ''));
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });

  // 等 WS 连上 + app.js 加载完
  await page.waitForFunction(() => typeof window.handleMessage === 'function', { timeout: 20000 });
  await page.waitForFunction(() => typeof window.switchChat === 'function', { timeout: 20000 });

  // 切到会话 B（当前会话）
  await page.evaluate((id) => window.switchChat(id), CHAT_B);
  await new Promise((r) => setTimeout(r, 1500));

  const cur = await page.evaluate(() => currentChat);
  check('已切到会话 B', cur === CHAT_B, 'currentChat=' + cur);

  // ── 场景 1：非当前会话 A 的 streaming.start ──
  await page.evaluate((a) => {
    window.handleMessage({
      type: 'agent.streaming.start',
      chatId: a,
      from: 'agent:agent-user-shen-389dd1',
      senderType: 'agent',
      msgId: 'iso-test-start-1',
      timestamp: Date.now(),
    });
  }, CHAT_A);
  await new Promise((r) => setTimeout(r, 600));

  let domText = await page.evaluate(() => document.getElementById('messages').textContent || '');
  let bubbleCount = await page.evaluate(() => document.querySelectorAll('#messages .msg-row').length);
  check('场景1：非当前会话的 streaming.start 不产生气泡', bubbleCount === 0, 'bubbleCount=' + bubbleCount);

  // ── 场景 2：非当前会话 A 的 streaming.chunk（最容易串的路径）──
  await page.evaluate((a) => {
    window.handleMessage({
      type: 'agent.streaming.chunk',
      chatId: a,
      from: 'agent:agent-user-shen-389dd1',
      msgId: 'iso-test-start-1',
      chunk: '这是会话A的机密内容ISO_MARKER_12345',
      timestamp: Date.now(),
    });
  }, CHAT_A);
  await new Promise((r) => setTimeout(r, 800));

  domText = await page.evaluate(() => document.getElementById('messages').textContent || '');
  bubbleCount = await page.evaluate(() => document.querySelectorAll('#messages .msg-row').length);
  check('场景2：非当前会话的 chunk 不产生气泡', bubbleCount === 0, 'bubbleCount=' + bubbleCount);
  check('场景2：会话A的内容不出现在会话B', !domText.includes('ISO_MARKER_12345'),
    domText.includes('ISO_MARKER_12345') ? '❌ 内容泄漏' : '无泄漏');

  // ── 场景 3：切回会话 A，历史正常加载 ──
  await page.evaluate((a) => window.switchChat(a), CHAT_A);
  await new Promise((r) => setTimeout(r, 2000));
  const curA = await page.evaluate(() => currentChat);
  const titleA = await page.evaluate(() => document.getElementById('chatTitle').textContent);
  check('场景3：可切回会话 A', curA === CHAT_A, 'currentChat=' + curA + ' title=' + titleA);

  // ── 场景 4：当前会话的 streaming.start 正常渲染（没修过头）──
  await page.evaluate((a) => {
    window.handleMessage({
      type: 'agent.streaming.start',
      chatId: a,
      from: 'agent:agent-user-shen-389dd1',
      senderType: 'agent',
      msgId: 'iso-test-start-2',
      timestamp: Date.now(),
    });
  }, CHAT_A);
  await new Promise((r) => setTimeout(r, 600));

  const bubbleCountA = await page.evaluate(() => document.querySelectorAll('#messages .msg-row').length);
  check('场景4：当前会话的 streaming.start 正常渲染气泡', bubbleCountA > 0, 'bubbleCount=' + bubbleCountA);

  // chunk 到达 → 内容应进入气泡
  await page.evaluate((a) => {
    window.handleMessage({
      type: 'agent.streaming.chunk',
      chatId: a,
      from: 'agent:agent-user-shen-389dd1',
      msgId: 'iso-test-start-2',
      chunk: '当前会话正常显示 ISO_OK_999',
      timestamp: Date.now(),
    });
  }, CHAT_A);
  await new Promise((r) => setTimeout(r, 1200));

  domText = await page.evaluate(() => document.getElementById('messages').textContent || '');
  check('场景4：当前会话的 chunk 内容正常显示', domText.includes('ISO_OK_999'),
    domText.includes('ISO_OK_999') ? '已显示' : '未显示');

  // ── 场景 5：切走后再切回，旧会话的迟到 chunk 不得串进新会话 ──
  await page.evaluate((b) => window.switchChat(b), CHAT_B);
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate((a) => {
    // 模拟「切走后 A 的流式还在跑，迟到 chunk」
    window.handleMessage({
      type: 'agent.streaming.chunk',
      chatId: a,
      from: 'agent:agent-user-shen-389dd1',
      msgId: 'iso-test-start-2',
      chunk: '迟到内容 LATE_MARKER_777',
      timestamp: Date.now(),
    });
  }, CHAT_A);
  await new Promise((r) => setTimeout(r, 1000));

  domText = await page.evaluate(() => document.getElementById('messages').textContent || '');
  check('场景5：切走后迟到 chunk 不串入新会话', !domText.includes('LATE_MARKER_777'),
    domText.includes('LATE_MARKER_777') ? '❌ 串了' : '未串');

  // ── 场景 6：退订消息已发出（服务端 wsSubscriptions 只增不减的补丁）──
  const unsubSent = await page.evaluate(() => {
    return new Promise((resolve) => {
      const orig = WebSocket.prototype.send;
      const seen = [];
      WebSocket.prototype.send = function (d) { seen.push(String(d)); return orig.call(this, d); };
      window.switchChat('chat-u-mvl4mmxz-adjo');
      setTimeout(() => {
        WebSocket.prototype.send = orig;
        resolve(seen.filter((x) => x.includes('unsubscribe')));
      }, 1200);
    });
  });
  check('场景6：切会话时发出 unsubscribe', unsubSent.length > 0,
    unsubSent.length ? unsubSent[0].slice(0, 90) : '未发出');

  const realErrors = errors.filter((e) => !/favicon|ERR_|Failed to load resource|404|status of 4\d\d|status of 5\d\d/i.test(e));
  check('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || '干净');

} catch (e) {
  check('E2E 执行异常', false, e.message);
  console.error(e);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log('\n═══ 结果：' + (results.length - failed.length) + '/' + results.length + ' 通过 ═══');
if (failed.length) {
  failed.forEach((f) => console.log('  ❌ ' + f.name + ' → ' + (f.detail || '')));
  process.exit(1);
}
console.log('🎉 会话隔离 E2E 全部通过');
