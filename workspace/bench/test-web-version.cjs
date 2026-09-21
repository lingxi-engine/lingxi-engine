const fs = require('fs');
const REPO = 'C:/Users/Administrator/lingxi-engine';
let pass = 0, total = 0;
const chk = (n, ok, extra) => { total++; if (ok) pass++; console.log((ok ? '✅ ' : '❌ ') + n + (ok ? '' : '  ' + (extra || ''))); };

// sw.js 语法
try { new Function(fs.readFileSync(REPO + '/web/sw.js', 'utf8')); chk('sw.js 可解析', true); }
catch (e) { chk('sw.js 可解析', false, e.message); }

// download.html 内联脚本可解析
const html = fs.readFileSync(REPO + '/web/download.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
chk('download.html 有内联脚本', scripts.length > 0, 'count=' + scripts.length);
let allParse = true, err = '';
for (const s of scripts) { try { new Function(s); } catch (e) { allParse = false; err = e.message; } }
chk('全部内联脚本可解析', allParse, err);

// 版本注入逻辑（复刻 HTML 里的替换规则）
const inject = (version) => {
  const v = 'v' + version;
  let title = '下载部署 · 灵犀引擎 v2.0.22';
  title = title.replace(/v\d+\.\d+\.\d+/, v);
  let pre = '# 期望返回 {"ok":true,"version":"2.0.22","agents":11,...}';
  pre = pre.replace(/"version":"\d+\.\d+\.\d+"/, '"version":"' + version + '"');
  const href = '/public/lingxi-engine-' + version + '.tar.gz';
  return { title, pre, href };
};
const r1 = inject('2.0.23');
chk('title 注入 2.0.23', r1.title.includes('v2.0.23'), r1.title);
chk('health 示例注入', r1.pre.includes('"2.0.23"'), r1.pre);
chk('下载链接注入', r1.href === '/public/lingxi-engine-2.0.23.tar.gz', r1.href);

// 静态回退值应为当前版本
chk('download.html 静态回退=2.0.22', /v2\.0\.22/.test(html) && !/v2\.0\.20/.test(html), 'still has 2.0.20?');
chk('sw.js CACHE=lingxi-v21', /CACHE_NAME = 'lingxi-v21'/.test(fs.readFileSync(REPO + '/web/sw.js', 'utf8')));

console.log(`\n结果: ${pass}/${total} ${pass === total ? 'PASS' : 'FAIL'}`);
process.exit(pass === total ? 0 : 1);
