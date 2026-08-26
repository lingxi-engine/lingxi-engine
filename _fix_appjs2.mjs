import fs from 'fs';

const p = 'web/js/app.js';
let s = fs.readFileSync(p, 'utf8');
const EOL = '\r\n';

const fixes = [
  {
    name: 'editProfile-用账号ID而非clientId',
    old: [
      "  // 获取当前用户 ID",
      "  var userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
    ],
    next: [
      "  // 获取当前用户 ID（[FIX] 优先账号ID，回退 clientId）",
      "  var userId = '';",
      "  try {",
      "    var _meU = await platformApi('/api/user/me', 'GET');",
      "    if (_meU && _meU.ok && _meU.user) userId = _meU.user.id || _meU.user.sub || clientId || '';",
      "  } catch(_e) {}",
      "  if (!userId) userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
    ],
  },
  {
    name: 'doUploadAvatar-用账号ID而非clientId',
    old: [
      "  var userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
      "  // 校验文件类型",
    ],
    next: [
      "  var userId = '';",
      "  try {",
      "    var _meA = await platformApi('/api/user/me', 'GET');",
      "    if (_meA && _meA.ok && _meA.user) userId = _meA.user.id || _meA.user.sub || clientId || '';",
      "  } catch(_e) {}",
      "  if (!userId) userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
      "  // 校验文件类型",
    ],
  },
];

let changed = 0;
for (const fix of fixes) {
  const oldStr = fix.old.join(EOL);
  const nextStr = fix.next.join(EOL);
  if (s.includes(oldStr)) {
    s = s.replace(oldStr, nextStr);
    changed++;
    console.log('OK:', fix.name);
  } else {
    const oldLf = fix.old.join('\n');
    if (s.includes(oldLf)) {
      s = s.replace(oldLf, fix.next.join('\n'));
      changed++;
      console.log('OK(LF):', fix.name);
    } else {
      console.error('NOT FOUND:', fix.name);
      const probe = fix.old[0].trim().slice(0, 30);
      const idx = s.indexOf(probe);
      console.error('  probe idx:', idx, idx >= 0 ? JSON.stringify(s.slice(idx, idx + 100)) : '');
    }
  }
}
fs.writeFileSync(p, s, 'utf8');
console.log('done, changed =', changed, '/', fixes.length);
