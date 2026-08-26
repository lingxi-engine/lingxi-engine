import fs from 'fs';
const p = 'C:/Users/Administrator/lingxi-engine/web/js/app.js';
let c = fs.readFileSync(p, 'utf8');
const oldS = `var userId = clientId || '';`;
const idx = c.indexOf('async function showCreditsDetail');
const segStart = c.indexOf(oldS, idx);
if (segStart < 0) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const newS = `var userId = '';
  try {
    var _meC = await platformApi('/api/user/me', 'GET');
    if (_meC && _meC.ok && _meC.user) userId = _meC.user.id || _meC.user.sub || clientId || '';
  } catch(_e) {}
  if (!userId) userId = clientId || '';`;
c = c.slice(0, segStart) + newS + c.slice(segStart + oldS.length);
fs.writeFileSync(p, c, 'utf8');
console.log('showCreditsDetail FIXED at offset ' + segStart);
