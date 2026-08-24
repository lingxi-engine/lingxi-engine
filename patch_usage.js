const fs = require('fs');
const path = 'src/core/usage-tracker.ts';
let src = fs.readFileSync(path, 'utf8');

// 1. 修改返回类型：加 daily 和 hourly
const oldType = `    recent24h: { calls: number; totalTokens: number };\n    recent1h: { calls: number; totalTokens: number };\n  } {`;
const newType = `    recent24h: { calls: number; totalTokens: number };\n    recent1h: { calls: number; totalTokens: number };\n    daily: { date: string; calls: number; totalTokens: number }[];\n    hourly: { hour: string; calls: number; totalTokens: number }[];\n  } {`;
if (!src.includes(oldType)) { console.error('FAIL: 未找到类型块'); process.exit(1); }
src = src.replace(oldType, newType);

// 2. 初始化时间序列变量
const oldInit = `    let recent24h = { calls: 0, totalTokens: 0 };\n    let recent1h = { calls: 0, totalTokens: 0 };`;
const newInit = `    let recent24h = { calls: 0, totalTokens: 0 };\n    let recent1h = { calls: 0, totalTokens: 0 };\n\n    // 时间序列：30天 + 24小时分桶\n    const dailyMap = new Map<string, { calls: number; totalTokens: number }>();\n    const hourlyMap = new Map<string, { calls: number; totalTokens: number }>();`;
if (!src.includes(oldInit)) { console.error('FAIL: 未找到初始化块'); process.exit(1); }
src = src.replace(oldInit, newInit);

// 3. 在循环内时间维度处加时间分桶
const oldLoop = `      const age = now - r.timestamp;\n      if (age < 3600000) { recent1h.calls++; recent1h.totalTokens += r.totalTokens; }\n      if (age < 86400000) { recent24h.calls++; recent24h.totalTokens += r.totalTokens; }\n    }`;
const newLoop = `      const age = now - r.timestamp;\n      if (age < 3600000) { recent1h.calls++; recent1h.totalTokens += r.totalTokens; }\n      if (age < 86400000) { recent24h.calls++; recent24h.totalTokens += r.totalTokens; }\n\n      // 按天分桶（最近30天）\n      const d = new Date(r.timestamp);\n      const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');\n      const dm = dailyMap.get(dayKey) || { calls: 0, totalTokens: 0 };\n      dm.calls++; dm.totalTokens += r.totalTokens;\n      dailyMap.set(dayKey, dm);\n\n      // 按小时分桶（最近24小时）\n      const hourKey = dayKey + ' ' + String(d.getHours()).padStart(2, '0') + ':00';\n      const hm = hourlyMap.get(hourKey) || { calls: 0, totalTokens: 0 };\n      hm.calls++; hm.totalTokens += r.totalTokens;\n      hourlyMap.set(hourKey, hm);\n    }`;
if (!src.includes(oldLoop)) { console.error('FAIL: 未找到循环内块'); process.exit(1); }
src = src.replace(oldLoop, newLoop);

// 4. 返回值加 daily 和 hourly（补全最近30天/24小时，缺失的天/小时填0）
const oldReturn = `    return { total, byModel, byType, recent24h, recent1h };`;
const newReturn = `    // 补全最近30天（缺失填0）\n    const daily: { date: string; calls: number; totalTokens: number }[] = [];\n    for (let i = 29; i >= 0; i--) {\n      const d = new Date(now - i * 86400000);\n      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');\n      const v = dailyMap.get(key) || { calls: 0, totalTokens: 0 };\n      daily.push({ date: key, calls: v.calls, totalTokens: v.totalTokens });\n    }\n    // 补全最近24小时（缺失填0）\n    const hourly: { hour: string; calls: number; totalTokens: number }[] = [];\n    for (let i = 23; i >= 0; i--) {\n      const d = new Date(now - i * 3600000);\n      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':00';\n      const v = hourlyMap.get(key) || { calls: 0, totalTokens: 0 };\n      hourly.push({ hour: key, calls: v.calls, totalTokens: v.totalTokens });\n    }\n    return { total, byModel, byType, recent24h, recent1h, daily, hourly };`;
if (!src.includes(oldReturn)) { console.error('FAIL: 未找到返回值块'); process.exit(1); }
src = src.replace(oldReturn, newReturn);

fs.writeFileSync(path, src);
console.log('OK: usage-tracker.ts 已更新');
