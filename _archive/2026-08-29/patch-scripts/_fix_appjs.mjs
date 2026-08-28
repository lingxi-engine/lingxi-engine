import fs from 'fs';

const p = 'web/js/app.js';
let s = fs.readFileSync(p, 'utf8');

const EOL = '\r\n';
const fixes = [
  {
    name: 'loadProfileCard-字段兼容驼峰',
    // 旧：只读下划线字段，云平台返回驼峰 → 全空
    old: [
      "    var userId = u.id || u.sub || '';",
      "    var name = u.display_name || u.username || t('profile.defaultUser');",
      "    var idShow = u.numeric_id || u.id || '';",
      "    var avatarUrl = u.avatar_url || '';",
      "    var bio = u.bio || '';",
      "    var credits = 0;",
    ],
    next: [
      "    var userId = u.id || u.sub || '';",
      "    // [FIX 个人中心] 兼容云平台驼峰字段（displayName/numericId/avatarUrl）+ 本地下划线字段",
      "    var name = u.display_name || u.displayName || u.username || t('profile.defaultUser');",
      "    var idShow = u.numeric_id || u.numericId || u.id || '';",
      "    var avatarUrl = u.avatar_url || u.avatarUrl || '';",
      "    var bio = u.bio || '';",
      "    var credits = (typeof u.credits !== 'undefined' && u.credits !== null) ? u.credits : 0;",
    ],
  },
  {
    name: 'loadProfileCard-credits云平台优先',
    old: ["        credits = (typeof u.points !== 'undefined' && u.points !== null) ? u.points : (pr.credits || 0); // v2.0.13: platform points first"],
    next: ["        credits = (typeof u.credits !== 'undefined' && u.credits !== null) ? u.credits : (pr.credits || 0); // v2.0.13: platform credits first"],
  },
  {
    name: 'editProfile-用账号ID而非clientId',
    old: [
      "  // 鑾峰彇褰撳墠鐢ㄦ埛 ID",
      "  var userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
    ],
    next: [
      "  // 鑾峰彇褰撳墠鐢ㄦ埛 ID（[FIX] 优先账号ID，回退 clientId）",
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
      "  // 鏍￠獙鏂囦欢绫诲瀷",
    ],
    next: [
      "  var userId = '';",
      "  try {",
      "    var _meA = await platformApi('/api/user/me', 'GET');",
      "    if (_meA && _meA.ok && _meA.user) userId = _meA.user.id || _meA.user.sub || clientId || '';",
      "  } catch(_e) {}",
      "  if (!userId) userId = clientId || '';",
      "  if (!userId) { toast(t('profile.noUserInfo')); return; }",
      "  // 鏍￠獙鏂囦欢绫诲瀷",
    ],
  },
  {
    name: 'showCreditsDetail-去掉未定义u引用',
    old: ["      credits = (typeof u.points !== 'undefined' && u.points !== null) ? u.points : (pr.credits || 0); // v2.0.13 platform points first"],
    next: ["      credits = pr.credits || 0; // [FIX] 去掉未定义的 u 引用"],
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
    // 尝试 LF 行尾
    const oldLf = fix.old.join('\n');
    if (s.includes(oldLf)) {
      s = s.replace(oldLf, fix.next.join('\n'));
      changed++;
      console.log('OK(LF):', fix.name);
    } else {
      console.error('NOT FOUND:', fix.name);
      // 定位近似位置，输出前 2 行帮助排查
      const probe = fix.old[0].trim().slice(0, 40);
      const idx = s.indexOf(probe);
      console.error('  probe idx:', idx, idx >= 0 ? JSON.stringify(s.slice(idx, idx + 120)) : '');
    }
  }
}

fs.writeFileSync(p, s, 'utf8');
console.log('done, changed =', changed, '/', fixes.length);
