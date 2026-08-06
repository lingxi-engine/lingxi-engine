/**
 * 灵犀引擎冒烟测试 v1.9.0
 * 用法: node tests/test-smoke.js [--browser]
 * 前提: 引擎已启动在 http://127.0.0.1:3456
 *   --browser  启用无头浏览器测试（需 puppeteer-core + Edge）
 */

const BASE = process.env.TEST_URL || 'http://127.0.0.1:3456';
const DO_BROWSER = process.argv.includes('--browser');
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2705 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u274c ${name}: ${e.message}`);
    failed++;
  }
}

async function api(path, method, body) {
  const opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: res.status }; }
}

async function apiRaw(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, text: await res.text() };
}

// ─── API 测试 ───
async function runApiTests() {
  console.log('\n\u2500\u2500\u2500 API \u7aef\u70b9\u6d4b\u8bd5 \u2500\u2500\u2500\n');

  await test('\u5065\u5eb7\u68c0\u67e5', async () => {
    const d = await api('/api/health');
    if (d.status !== 'ok') throw new Error('status=' + d.status);
  });

  await test('\u7248\u672c\u53f7', async () => {
    const d = await api('/api/version');
    if (!d.version) throw new Error('\u65e0\u7248\u672c\u53f7');
  });

  await test('\u6a21\u578b\u5217\u8868\u4e0d\u4e3a\u7a7a', async () => {
    const d = await api('/api/providers');
    if (!d.models || d.models.length === 0) throw new Error('\u65e0\u6a21\u578b');
  });

  await test('Agent \u5217\u8868', async () => {
    const d = await api('/api/agents');
    if (!d.agents) throw new Error('\u65e0 agents \u5b57\u6bb5');
  });

  await test('\u6c99\u7bb1\u72b6\u6001 API (\u53ef\u9009)', async () => {
    const r = await apiRaw('/api/sandbox');
    if (r.status === 404) return; // \u7aef\u70b9\u53ef\u80fd\u672a\u542f\u7528
    const d = JSON.parse(r.text);
    if (typeof d.enabled !== 'boolean') throw new Error('enabled \u4e0d\u662f\u5e03\u5c14');
  });

  await test('\u5de5\u4f5c\u533a\u6a21\u5f0f API', async () => {
    const d = await api('/api/workspace-mode');
    if (typeof d.collabMode !== 'boolean') throw new Error('collabMode \u4e0d\u662f\u5e03\u5c14');
    if (!d.workspaceRoot) throw new Error('\u65e0 workspaceRoot');
  });

  await test('\u65f6\u95f4\u5de5\u5177 API', async () => {
    const d = await api('/api/time');
    if (!d.iso) throw new Error('\u65e0 iso \u65f6\u95f4');
  });

  await test('\u65e5\u5fd7 API (\u9700\u8ba4\u8bc1)', async () => {
    const r = await apiRaw('/api/logs?limit=5');
    if (r.status === 401 || r.status === 403 || r.status === 503) return; // \u672a\u914d ADMIN_TOKEN \u65f6\u62d2\u7edd\u662f\u6b63\u5e38\u7684
    const d = JSON.parse(r.text);
    if (!d.lines && !d.logs) throw new Error('\u65e0 lines/logs');
  });

  await test('\u5ba1\u6279 API', async () => {
    const d = await api('/api/approval/pending');
    if (!d.requests && !d.pending) throw new Error('\u683c\u5f0f\u9519\u8bef');
  });

  await test('RAG \u6587\u6863 API', async () => {
    const d = await api('/api/rag/documents');
    if (!d.documents) throw new Error('\u65e0 documents');
  });

  // ── v1.9.0 \u65b0\u589e\u7aef\u70b9 ──
  await test('\u641c\u7d22\u6d88\u606f API', async () => {
    const d = await api('/api/search/messages?q=test');
    if (!d.ok) throw new Error('ok=' + d.ok);
    if (!Array.isArray(d.results)) throw new Error('results \u4e0d\u662f\u6570\u7ec4');
  });

  await test('\u641c\u7d22\u7f3a\u5c11\u53c2\u6570\u8fd4\u56de 400', async () => {
    const r = await apiRaw('/api/search/messages');
    if (r.status !== 400) throw new Error('\u671f\u671b 400, \u5b9e\u9645 ' + r.status);
  });

  await test('\u5bfc\u51fa\u5907\u4efd API', async () => {
    const r = await apiRaw('/api/export/backup');
    if (r.status !== 200) throw new Error('\u72b6\u6001\u7801 ' + r.status);
    const d = JSON.parse(r.text);
    if (!d.exportedAt) throw new Error('\u7f3a\u5c11 exportedAt');
    if (!Array.isArray(d.chats)) throw new Error('chats \u4e0d\u662f\u6570\u7ec4');
  });

  // ── \u524d\u7aef\u9759\u6001\u8d44\u6e90 ──
  await test('\u9996\u9875 HTML \u53ef\u8bbf\u95ee', async () => {
    const r = await apiRaw('/');
    if (r.status !== 200) throw new Error('\u72b6\u6001\u7801 ' + r.status);
    if (!r.text.includes('<!DOCTYPE html') && !r.text.includes('<!doctype html')) throw new Error('\u975e HTML');
  });

  await test('i18n.js \u53ef\u8bbf\u95ee', async () => {
    const r = await apiRaw('/js/i18n.js');
    if (r.status !== 200) throw new Error('\u72b6\u6001\u7801 ' + r.status);
    if (!r.text.includes('applyLanguage')) throw new Error('\u5185\u5bb9\u4e0d\u5bf9');
  });

  await test('manifest.json \u53ef\u8bbf\u95ee', async () => {
    const r = await apiRaw('/manifest.json');
    if (r.status !== 200) throw new Error('\u72b6\u6001\u7801 ' + r.status);
  });
}

// ─── \u6d4f\u89c8\u5668\u6d4b\u8bd5 ───
async function runBrowserTests() {
  console.log('\n\u2500\u2500\u2500 \u6d4f\u89c8\u5668\u6d4b\u8bd5 (\u65e0\u5934 Edge) \u2500\u2500\u2500\n');

  let puppeteer;
  try { puppeteer = await import('puppeteer-core'); } catch (e) {
    console.log('  \u26a0\ufe0f  puppeteer-core \u52a0\u8f7d\u5931\u8d25: ' + e.code + ' ' + e.message);
    return;
  }

  const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/EdgeCore/149.0.4022.69/msedge.exe';
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    console.log('  \u26a0\ufe0f  \u65e0\u6cd5\u542f\u52a8 Edge: ' + e.message);
    return;
  }

  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => pageErrors.push(err.message));

    await test('\u9875\u9762\u52a0\u8f7d\u65e0 JS \u9519\u8bef', async () => {
      await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 15000 });
      // \u7b49\u4e00\u4e0b\u52a8\u6001\u9519\u8bef
      await new Promise(r => setTimeout(r, 1500));
      if (pageErrors.length) throw new Error(pageErrors.join('; '));
    });

    await test('i18n \u521d\u59cb\u5316\u6210\u529f', async () => {
      const hasI18N = await page.evaluate(() => !!window.I18N);
      if (!hasI18N) throw new Error('window.I18N \u672a\u5b9a\u4e49');
    });

    await test('t() \u51fd\u6570\u53ef\u7528', async () => {
      const val = await page.evaluate(() => typeof t === 'function' && t('app.name'));
      if (!val) throw new Error('t() \u4e0d\u53ef\u7528');
    });

    await test('\u8bed\u8a00\u5207\u6362\u5668\u5b58\u5728', async () => {
      const exists = await page.evaluate(() => !!document.getElementById('langSelect'));
      if (!exists) throw new Error('#langSelect \u4e0d\u5b58\u5728');
    });

    await test('\u8bbe\u7f6e\u9762\u677f\u6709\u901a\u77e5\u533a\u57df5e', async () => {
      // \u6253\u5f00\u8bbe\u7f6e
      await page.evaluate(() => { if (typeof openSettings === 'function') openSettings(); });
      await new Promise(r => setTimeout(r, 500));
      const hasNotify = await page.evaluate(() => !!document.getElementById('notifyToggle'));
      const hasExport = await page.evaluate(() => !!document.getElementById('exportBackup') || !!document.querySelector('[onclick*="exportBackup"]'));
      if (!hasNotify) throw new Error('\u7f3a\u5c11 #notifyToggle');
      if (!hasExport) throw new Error('\u7f3a\u5c11\u5bfc\u51fa\u6309\u94ae');
    });

    await test('\u641c\u7d22\u6309\u94ae\u5b58\u5728', async () => {
      const exists = await page.evaluate(() => !!document.getElementById('searchToggleBtn'));
      if (!exists) throw new Error('#searchToggleBtn \u4e0d\u5b58\u5728');
    });

    await test('\u641c\u7d22\u680f\u53ef\u5207\u6362', async () => {
      await page.evaluate(() => toggleChatSearch());
      await new Promise(r => setTimeout(r, 200));
      const display = await page.evaluate(() => document.getElementById('chatSearchBar').style.display);
      if (display === 'none') throw new Error('\u641c\u7d22\u680f\u672a\u663e\u793a');
      // \u518d\u6b21\u5207\u6362\u5173\u95ed
      await page.evaluate(() => toggleChatSearch());
    });

    await test('\u5207\u6362\u8bed\u8a00\u5230 English', async () => {
      await page.evaluate(() => applyLanguage('en'));
      await new Promise(r => setTimeout(r, 300));
      const title = await page.evaluate(() => document.querySelector('[data-i18n="settings.title"]')?.textContent);
      if (!title || title === '\u2699\ufe0f \u8bbe\u7f6e') throw new Error('\u8bed\u8a00\u672a\u5207\u6362: ' + title);
      // \u5207\u56de\u4e2d\u6587
      await page.evaluate(() => applyLanguage('zh'));
    });

    await test('PWA manifest \u52a0\u8f7d', async () => {
      const hasManifest = await page.evaluate(() => !!document.querySelector('link[rel="manifest"]'));
      if (!hasManifest) throw new Error('\u7f3a\u5c11 manifest link');
    });

    // \u6c47\u603b\u62a5\u544a
    if (consoleErrors.length) {
      console.log(`  \u26a0\ufe0f  \u63a7\u5236\u53f0\u9519\u8bef (${consoleErrors.length}): ${consoleErrors.slice(0, 3).join('; ')}`);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log(`\n\ud83e\uddea \u7075\u7280\u5f15\u64ce\u5192\u70df\u6d4b\u8bd5 v1.9.0 \u2014 ${BASE}`);
  if (DO_BROWSER) console.log('  \u6d4f\u89c8\u5668\u6d4b\u8bd5: \u5df2\u542f\u7528');

  await runApiTests();
  if (DO_BROWSER) await runBrowserTests();

  console.log(`\n\ud83d\udcca \u7ed3\u679c: ${passed} \u901a\u8fc7, ${failed} \u5931\u8d25\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
