// 补丁脚本：给 package.json 加 setup:browser 脚本
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!p.scripts['setup:browser']) {
  p.scripts['setup:browser'] = 'npm install puppeteer --no-save';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n', 'utf8');
  console.log('[patch] setup:browser 已加入 package.json');
} else {
  console.log('[patch] setup:browser 已存在，跳过');
}
console.log('当前 scripts:', JSON.stringify(p.scripts, null, 2));
