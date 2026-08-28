// platform-server.ts 补丁：users表迁移 + 返回字段双格式 + friend/hire 字段对齐 + heartbeat 兼容
import { readFileSync, writeFileSync, copyFileSync } from 'fs';

const F = 'src/platform-server.ts';
const src = readFileSync(F, 'utf8');
copyFileSync(F, F + '.bak-platform-20260827-014948');

let s = src;
const applied = [];

// ============ 1. SCHEMA: users 表补 bio/email_verified/status 列（新库） ============
s = s.replace(
  `  avatar_url TEXT DEFAULT '',\n  created_at INTEGER NOT NULL,\n  registered_instance TEXT DEFAULT ''\n);`,
  `  avatar_url TEXT DEFAULT '',\n  bio TEXT DEFAULT '',\n  email_verified INTEGER DEFAULT 0,\n  status TEXT DEFAULT 'active',\n  created_at INTEGER NOT NULL,\n  registered_instance TEXT DEFAULT ''\n);`
);
applied.push('SCHEMA.users+bio/email_verified/status');

// ============ 2. migrateUsersTable: 老库 ALTER TABLE 加列 ============
s = s.replace(
  `  sqlDb.run(SCHEMA);\n  saveDB();\n  migrateFromJson();\n}`,
  `  sqlDb.run(SCHEMA);\n  migrateUsersTable();\n  saveDB();\n  migrateFromJson();\n}\n\n// 老库迁移: users 表补列（ALTER TABLE 幂等）\nfunction migrateUsersTable() {\n  try {\n    const cols = (sqlDb.exec("PRAGMA table_info(users)")[0]?.values || []).map((v: any) => v[1]);\n    if (!cols.includes('bio')) sqlDb.run("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");\n    if (!cols.includes('email_verified')) sqlDb.run("ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0");\n    if (!cols.includes('status')) sqlDb.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");\n    console.log('[DB] migrateUsersTable: 老库 users 表结构已对齐 (bio/email_verified/status)');\n  } catch (e: any) {\n    console.error('[DB] migrateUsersTable 失败:', e.message);\n  }\n}`
);
applied.push('initDB->migrateUsersTable');

// ============ 3. register: 返回体补全（双格式） ============
s = s.replace(
  `  res.json({ ok: true, user: { id: userId, numericId, email: em, displayName: dn, credits: 1000 }, token: genJwt(userId) });`,
  `  res.json({ ok: true, user: { id: userId, numeric_id: numericId, numericId, email: em, display_name: dn, displayName: dn, avatar_url: '', avatarUrl: '', bio: '', email_verified: 0, status: 'active', credits: 1000 }, token: genJwt(userId) });`
);
applied.push('register返回双格式');

// ============ 4. login: SELECT 补列 + 返回双格式 ============
s = s.replace(
  `  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name, password_hash FROM users WHERE email = $em");`,
  `  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name, avatar_url, bio, email_verified, status, password_hash FROM users WHERE email = $em");`
);
s = s.replace(
  `  const { id, numeric_id: nid, email: em2, display_name: dn, password_hash: ph } = row as any;`,
  `  const { id, numeric_id: nid, email: em2, display_name: dn, avatar_url: av, bio: bioTxt, email_verified: ev, status: st, password_hash: ph } = row as any;`
);
s = s.replace(
  `  res.json({ ok: true, user: { id, numericId: nid, email: em2, displayName: dn, credits }, token: genJwt(id as string) });`,
  `  res.json({ ok: true, user: { id, numeric_id: nid, numericId: nid, email: em2, display_name: dn, displayName: dn, avatar_url: av || '', avatarUrl: av || '', bio: bioTxt || '', email_verified: ev || 0, status: st || 'active', credits }, token: genJwt(id as string) });`
);
applied.push('login SELECT补列+返回双格式');

// ============ 5. /api/user/me: SELECT 补列 + 返回双格式 ============
s = s.replace(
  `  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name FROM users WHERE id = $u");`,
  `  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name, avatar_url, bio, email_verified, status FROM users WHERE id = $u");`
);
s = s.replace(
  `  const { id, numeric_id: nid, email: em, display_name: dn } = row as any;`,
  `  const { id, numeric_id: nid, email: em, display_name: dn, avatar_url: av, bio: bioTxt, email_verified: ev, status: st } = row as any;`
);
s = s.replace(
  `  res.json({ ok: true, user: { id, numericId: nid, email: em, displayName: dn, credits } });`,
  `  res.json({ ok: true, user: { id, numeric_id: nid, numericId: nid, email: em, display_name: dn, displayName: dn, avatar_url: av || '', avatarUrl: av || '', bio: bioTxt || '', email_verified: ev || 0, status: st || 'active', credits } });`
);
applied.push('me SELECT补列+返回双格式');

// ============ 6. friend/requests: incoming 补 fromUserId/fromNumericId ============
s = s.replace(
  `    incoming.push({ id: r.id, from: r.from_id, fromName: r.from_name, fromId: r.from_id_num, message: r.message });`,
  `    incoming.push({ id: r.id, from: r.from_id, fromUserId: r.from_id, fromName: r.from_name, fromId: r.from_id_num, fromNumericId: r.from_id_num, message: r.message });`
);
applied.push('friend/requests+fromUserId/fromNumericId');

// ============ 7. friend/list: 返回 friendId/friendName/friendEmail（前端字段） ============
s = s.replace(
  `    \`SELECT DISTINCT u.id, u.numeric_id, u.display_name FROM friends f\n     JOIN users u ON u.id = CASE WHEN f.from_id = $u THEN f.user_id ELSE f.from_id END\n     WHERE f.from_id = $u2 OR f.user_id = $u3\`);`,
  `    \`SELECT DISTINCT u.id, u.numeric_id, u.display_name, u.email FROM friends f\n     JOIN users u ON u.id = CASE WHEN f.from_id = $u THEN f.user_id ELSE f.from_id END\n     WHERE f.from_id = $u2 OR f.user_id = $u3\`);`
);
s = s.replace(
  `  const friends: any[] = [];\n  while (stmt.step()) friends.push(stmt.getAsObject());\n  stmt.free();\n  res.json({ ok: true, friends });`,
  `  const friends: any[] = [];\n  while (stmt.step()) {\n    const r = stmt.getAsObject();\n    friends.push({ friendId: r.id, friendName: r.display_name, friendEmail: r.email || '', id: r.id, numericId: r.numeric_id, displayName: r.display_name, email: r.email || '' });\n  }\n  stmt.free();\n  res.json({ ok: true, friends });`
);
applied.push('friend/list+friendId/friendName/friendEmail');

// ============ 8. hire/list 返回 listing 补 description ============
s = s.replace(
  `  res.json({ ok: true, listing: { id, name: name || '灵犀员工', desc: desc || '', pricePerTask: pricePerTask || 0 } });`,
  `  res.json({ ok: true, listing: { id, name: name || '灵犀员工', description: desc || '', desc: desc || '', pricePerTask: pricePerTask || 0 } });`
);
applied.push('hire/list+description');

// ============ 9. hire/market: list 补 description ============
s = s.replace(
  `    list.push({ id: r.id, name: r.name, desc: r.description, pricePerTask: r.price_per_task, ownerName: r.owner_name, ownerId: r.owner_id, agentId: r.agent_id, instanceId: r.instance_id });`,
  `    list.push({ id: r.id, name: r.name, description: r.description, desc: r.description, pricePerTask: r.price_per_task, ownerName: r.owner_name, ownerId: r.owner_id, agentId: r.agent_id, instanceId: r.instance_id });`
);
applied.push('hire/market+description');

// ============ 10. heartbeat: users 数组兼容驼峰/下划线 ============
s = s.replace(
  `        { $i: instanceId, $uid: u.userId, $nid: u.numericId, $dn: u.displayName || '', $em: u.email || '' });`,
  `        { $i: instanceId, $uid: u.userId ?? u.user_id, $nid: u.numericId ?? u.numeric_id, $dn: u.displayName ?? u.display_name ?? '', $em: u.email ?? '' });`
);
applied.push('heartbeat users兼容双格式');

// ============ 11. user/search 和 user/find 返回双格式（前端展示用） ============
s = s.replace(
  `  const results: any[] = [];\n  while (stmt.step()) results.push(stmt.getAsObject());\n  stmt.free();\n  res.json({ ok: true, results });`,
  `  const results: any[] = [];\n  while (stmt.step()) {\n    const r = stmt.getAsObject();\n    results.push({ id: r.id, numeric_id: r.numeric_id, numericId: r.numeric_id, display_name: r.display_name, displayName: r.display_name, email: r.email });\n  }\n  stmt.free();\n  res.json({ ok: true, results });`
);
s = s.replace(
  `    res.json({ ok: true, found: true, user: u });`,
  `    res.json({ ok: true, found: true, user: { id: u.id, numeric_id: u.numeric_id, numericId: u.numeric_id, display_name: u.display_name, displayName: u.display_name, email: u.email } });`
);
applied.push('search/find返回双格式');

writeFileSync(F, s, 'utf8');
console.log('Applied patches:', applied.length);
applied.forEach(a => console.log('  ✅', a));
