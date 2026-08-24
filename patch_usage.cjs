const fs = require('fs');
const path = 'src/core/usage-tracker.ts';
let src = fs.readFileSync(path, 'utf8');
const nl = src.includes('\r\n') ? '\r\n' : '\n';

// 归一化换行便于匹配（保留原换行）
const norm = src.replace(/\r\n/g, '\n');

// 1. 返回类型加 daily 和 hourly
const oldType = `    recent24h: { calls: number; totalTokens: number };
    recent1h: { calls: number; totalTokens: number };
  } {`;
const newType = `    recent24h: { calls: number; totalTokens: number };
    recent1h: { calls: number; totalTokens: number };
    daily: { date: string; calls: number; totalTokens: number }[];
    hourly: { hour: string; calls: number; totalTokens: number }[];
  } {`;
if (!norm.includes(oldType)) { console.error('FAIL-1'); process.exit(1); }
let out = norm.replace(oldType, newType);

// 2. 初始化时间序列变量
const oldInit = `    let recent24h = { calls: 0, totalTokens: 0 };
    let recent1h = { calls: 0, totalTokens: 0 };`;
const newInit = `    let recent24h = { calls: 0, totalTokens: 0 };
    let recent1h = { calls: 0, totalTokens: 0 };

    // 时间序列：30天 + 24小时分桶
    const dailyMap = new Map<string, { calls: number; totalTokens: number }>();
    const hourlyMap = new Map<string, { calls: number; totalTokens: number }>();`;
if (!out.includes(oldInit)) { console.error('FAIL-2'); process.exit(1); }
out = out.replace(oldInit, newInit);

// 3. 循环内时间维度处加时间分桶
const oldLoop = `      const age = now - r.timestamp;
      if (age < 3600000) { recent1h.calls++; recent1h.totalTokens += r.totalTokens; }
      if (age < 86400000) { recent24h.calls++; recent24h.totalTokens += r.totalTokens; }
    }`;
const newLoop = `      const age = now - r.timestamp;
      if (age < 3600000) { recent1h.calls++; recent1h.totalTokens += r.totalTokens; }
      if (age < 86400000) { recent24h.calls++; recent24h.totalTokens += r.totalTokens; }

      // 按天分桶（最近30天）
      const d = new Date(r.timestamp);
      const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const dm = dailyMap.get(dayKey) || { calls: 0, totalTokens: 0 };
      dm.calls++; dm.totalTokens += r.totalTokens;
      dailyMap.set(dayKey, dm);

      // 按小时分桶（最近24小时）
      const hourKey = dayKey + ' ' + String(d.getHours()).padStart(2, '0') + ':00';
      const hm = hourlyMap.get(hourKey) || { calls: 0, totalTokens: 0 };
      hm.calls++; hm.totalTokens += r.totalTokens;
      hourlyMap.set(hourKey, hm);
    }`;
if (!out.includes(oldLoop)) { console.error('FAIL-3'); process.exit(1); }
out = out.replace(oldLoop, newLoop);

// 4. 返回值加 daily 和 hourly
const oldReturn = `    return { total, byModel, byType, recent24h, recent1h };`;
const newReturn = `    // 补全最近30天（缺失填0）
    const daily: { date: string; calls: number; totalTokens: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const v = dailyMap.get(key) || { calls: 0, totalTokens: 0 };
      daily.push({ date: key, calls: v.calls, totalTokens: v.totalTokens });
    }
    // 补全最近24小时（缺失填0）
    const hourly: { hour: string; calls: number; totalTokens: number }[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now - i * 3600000);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':00';
      const v = hourlyMap.get(key) || { calls: 0, totalTokens: 0 };
      hourly.push({ hour: key, calls: v.calls, totalTokens: v.totalTokens });
    }
    return { total, byModel, byType, recent24h, recent1h, daily, hourly };`;
if (!out.includes(oldReturn)) { console.error('FAIL-4'); process.exit(1); }
out = out.replace(oldReturn, newReturn);

// 恢复原换行符
out = out.replace(/\n/g, nl);
fs.writeFileSync(path, out);
console.log('OK: usage-tracker.ts 已更新');
