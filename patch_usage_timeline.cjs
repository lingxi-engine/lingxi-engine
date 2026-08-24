const fs = require('fs');

// ═══ 1. app.js: 加时间线渲染 ═══
const appPath = 'web/js/app.js';
let app = fs.readFileSync(appPath, 'utf8');
const nl = app.includes('\r\n') ? '\r\n' : '\n';

// 1a. 在 loadUsage 之前插入渲染辅助函数
const helper = [
  '// ── Token 时间线渲染（30天/24小时 柱状图）──',
  'function renderUsageTimeline(items, keyField, title) {',
  '  var max = Math.max.apply(null, items.map(function(i){ return i.totalTokens; }).concat([1]));',
  '  var bars = items.map(function(i) {',
  '    var h = i.totalTokens > 0 ? Math.max(3, Math.round(i.totalTokens / max * 56)) : 2;',
  '    var label = i[keyField] + ": " + i.totalTokens.toLocaleString() + " tokens / " + i.calls + t(\'admin.timesUnit\');',
  '    var color = i.totalTokens > 0 ? \'var(--accent)\' : \'rgba(255,255,255,.08)\';',
  '    return \'<div title="\' + esc(label) + \'" style="flex:1;min-width:2px;height:\' + h + \'px;background:\' + color + \';border-radius:2px 2px 0 0"></div>\';',
  '  }).join(\'\');',
  '  var total = items.reduce(function(a, i){ return a + i.totalTokens; }, 0);',
  '  return \'<div style="margin-top:8px"><b>\' + title + \'</b> <span style="color:var(--text3);font-size:10px">\u2211 \' + total.toLocaleString() + \' tokens</span>\' +',
  '    \'<div style="display:flex;align-items:flex-end;gap:2px;height:60px;padding:6px 4px 2px;background:rgba(0,0,0,.25);border-radius:6px;margin-top:4px">\' + bars + \'</div></div>\';',
  '}',
  ''
].join(nl);

const anchorFn = 'async function loadUsage() {';
if (!app.includes(anchorFn)) { console.error('FAIL-1: loadUsage anchor not found'); process.exit(1); }
if (app.includes('renderUsageTimeline')) { console.error('SKIP: already patched (app.js)'); }
else {
  app = app.replace(anchorFn, helper + anchorFn);
  // 1b. 在 usageStats.innerHTML 赋值前插入时间线渲染调用
  const anchorRender = "    document.getElementById('usageStats').innerHTML = html || t('admin.noData');";
  if (!app.includes(anchorRender)) { console.error('FAIL-2: usageStats anchor not found'); process.exit(1); }
  const inject = [
    '    // ── 时间线：每日(30天) + 每小时(24小时) ──',
    '    if (Array.isArray(s.daily) && s.daily.length) {',
    "      html += renderUsageTimeline(s.daily, 'date', t('admin.dailyTimeline'));",
    '    }',
    '    if (Array.isArray(s.hourly) && s.hourly.length) {',
    "      html += renderUsageTimeline(s.hourly, 'hour', t('admin.hourlyTimeline'));",
    '    }',
    anchorRender
  ].join(nl);
  app = app.replace(anchorRender, inject);
  fs.writeFileSync(appPath, app);
  console.log('OK-1: app.js 时间线渲染已加入');
}

// ═══ 2. i18n.js: 7 种语言加 dailyTimeline / hourlyTimeline ═══
const i18nPath = 'web/js/i18n.js';
let i18n = fs.readFileSync(i18nPath, 'utf8');
if (i18n.includes('admin.dailyTimeline')) { console.error('SKIP: already patched (i18n.js)'); process.exit(0); }
const i18nNl = i18n.includes('\r\n') ? '\r\n' : '\n';

// 按文件出现顺序: zh, zh-TW, en, ja, ko, vi, th
const trans = [
  ["每日时间线（近30天）", "每小时时间线（近24小时）"],
  ["每日時間軸（近30天）", "每小時時間軸（近24小時）"],
  ["Daily timeline (last 30 days)", "Hourly timeline (last 24 hours)"],
  ["日次タイムライン（直近30日）", "時間別タイムライン（直近24時間）"],
  ["일별 타임라인 (최근 30일)", "시간별 타임라인 (최근 24시간)"],
  ["Dòng thời gian theo ngày (30 ngày)", "Dòng thời gian theo giờ (24 giờ)"],
  ["เส้นเวลาตามวัน (30 วันล่าสุด)", "เส้นเวลาตามชั่วโมง (24 ชั่วโมงล่าสุด)"]
];

const byTypeRe = /^([ \t]*)'admin\.byType':[^\n]*$/gm;
let idx = 0, failed = false;
i18n = i18n.replace(byTypeRe, function(line, indent) {
  if (idx >= trans.length) { failed = true; return line; }
  const pair = trans[idx++];
  return line + i18nNl +
    indent + "'admin.dailyTimeline': '" + pair[0] + "'," + i18nNl +
    indent + "'admin.hourlyTimeline': '" + pair[1] + "',";
});
if (failed || idx !== 7) { console.error('FAIL-3: byType occurrences = ' + idx + ' (expected 7)'); process.exit(1); }
fs.writeFileSync(i18nPath, i18n);
console.log('OK-2: i18n.js 7 种语言文案已加入');
