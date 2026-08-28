import fs from 'fs';

const p = 'src/storage/db.ts';
let s = fs.readFileSync(p, 'utf8');

// 旧实现：只按主键 id 查（用正则容忍 CRLF/LF 行尾）
const oldRe = /export function getUser\(id: string\) \{\r?\n  const stmt = _db\.prepare\("SELECT \* FROM users WHERE id = \?"\);\r?\n  stmt\.bind\(\[id\]\);\r?\n  if \(stmt\.step\(\)\) \{ const row = stmt\.getAsObject\(\); stmt\.free\(\); return row; \}\r?\n  stmt\.free\(\);\r?\n  return undefined;\r?\n\}/;

// 新实现：id 与 numeric_id 双格式兼容（修复个人中心"用户不存在"404）
const newFn = `export function getUser(id: string) {
  // [FIX 个人中心] 双格式兼容：优先按主键 id 查；查不到再按 numeric_id（数字ID）查
  // 背景：旧注册接口用 String(numericId) 当 id，V7 用纯数字字符串 id，云平台用 "ouid-N" 格式，
  // 导致同一用户在不同路径下 id 格式不一致，按单一格式查询必然 404。
  let stmt = _db.prepare("SELECT * FROM users WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  const nid = Number(id);
  if (!Number.isNaN(nid) && String(nid) === String(id).trim()) {
    stmt = _db.prepare("SELECT * FROM users WHERE numeric_id = ?");
    stmt.bind([nid]);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
    stmt.free();
  }
  return undefined;
}`;

if (!oldRe.test(s)) {
  console.error('PATTERN NOT FOUND (oldRe)');
  const m = s.match(/export function getUser[\s\S]*?return undefined;\r?\n\}/);
  console.error('actual:', m ? JSON.stringify(m[0]) : 'NO MATCH');
  process.exit(1);
}
s = s.replace(oldRe, newFn);
fs.writeFileSync(p, s, 'utf8');
console.log('getUser patched OK');
