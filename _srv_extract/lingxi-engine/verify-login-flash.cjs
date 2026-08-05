// 验证"登录后双连接"不再触发重连死循环（闪断）
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/EdgeCore/149.0.4022.69/msedge.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();

  // 注入 WebSocket 计数器（在页面脚本之前）
  await page.evaluateOnNewDocument(() => {
    window.__wsOpen = 0; window.__wsClose = 0; window.__wsCreated = 0;
    const OrigWS = window.WebSocket;
    function HookedWS(url, proto) {
      window.__wsCreated++;
      const s = proto ? new OrigWS(url, proto) : new OrigWS(url);
      s.addEventListener('open', () => { window.__wsOpen++; });
      s.addEventListener('close', () => { window.__wsClose++; });
      return s;
    }
    HookedWS.prototype = OrigWS.prototype;
    HookedWS.CONNECTING = OrigWS.CONNECTING; HookedWS.OPEN = OrigWS.OPEN;
    HookedWS.CLOSING = OrigWS.CLOSING; HookedWS.CLOSED = OrigWS.CLOSED;
    window.WebSocket = HookedWS;
  });

  await page.goto('http://127.0.0.1:3456', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500)); // 等初始连接稳定

  const before = await page.evaluate(() => ({ open: window.__wsOpen, close: window.__wsClose, created: window.__wsCreated }));
  console.log('[初始稳定后]', JSON.stringify(before));

  // 模拟登录：设置 token 并触发第二次 connect()（这正是 submitAuth 的行为）
  await page.evaluate(() => {
    window.authToken = 'fake-cloud-token-simulating-login';
    if (typeof connect === 'function') connect();
  });
  await new Promise(r => setTimeout(r, 6000)); // 给足时间观察是否死循环

  const after = await page.evaluate(() => ({
    open: window.__wsOpen, close: window.__wsClose, created: window.__wsCreated,
    inputDisabled: document.getElementById('input') ? document.getElementById('input').disabled : null,
    statusText: document.getElementById('status') ? document.getElementById('status').textContent : '',
    wsState: document.getElementById('wsState') ? document.getElementById('wsState').textContent : '',
  }));
  console.log('[模拟登录6秒后]', JSON.stringify(after));

  const dOpen = after.open - before.open;
  const dClose = after.close - before.close;
  const dCreated = after.created - before.created;
  console.log('---');
  console.log('新增 open=' + dOpen + ' close=' + dClose + ' created=' + dCreated);

  // 判定：登录后新连接应只建立1次(open+1)，不应反复 close/重连
  let pass = true;
  if (dCreated > 2) { console.log('FAIL: 登录后创建了 ' + dCreated + ' 个WebSocket(应<=2)，存在重连循环'); pass = false; }
  if (dClose > 2) { console.log('FAIL: 登录后关闭了 ' + dClose + ' 次(应<=2)，存在闪断'); pass = false; }
  if (after.inputDisabled === true) { console.log('FAIL: 输入框被禁用'); pass = false; }
  if (after.statusText && after.statusText.indexOf('重连中') >= 0) { console.log('FAIL: 状态显示重连中: ' + after.statusText); pass = false; }

  console.log(pass
    ? ('PASS: 登录后稳定，输入框可用，状态="' + after.statusText + '" wsState="' + after.wsState + '"')
    : 'OVERALL: FAIL');

  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
