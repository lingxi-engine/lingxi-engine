/**
 * repair-orphan-groups.cjs —— 存量孤儿群一次性修复（部署后、启动服务前运行一次）
 *
 * 用法：
 *   node scripts/repair-orphan-groups.cjs            # 修复 data/main.db
 *   node scripts/repair-orphan-groups.cjs <db路径>   # 修复指定 db（用于测试/其他实例）
 *
 * 修复对象：
 *  1) AGI进化组 (team-mt7qknoh)：补 owner 参与者（u-mt4rw52m-oo58）+ 回填群名
 *  2) 通用兜底：扫描所有 type=group 且没有任何 user 参与者的孤儿群，
 *     用群内 agent-u-*（真实平台用户 AI 助手）的归属用户补 owner；
 *     名字为空且能确定的群补名字；无法推断的群打印提示人工处理。
 *  3) smoke 测试残留群 type='team' 归一为 'group'
 *  4) 清理幽灵参与者行：
 *     a) user_id 与 agent_id 双空的行
 *     b) chat_id 指向不存在群的行（群被删后残留的 owner/member 行）
 *
 * ⚠️ 运行前提：服务必须处于停止状态（sql.js 每 5 秒全量写盘，运行中修改会被覆盖）。
 *    脚本会自动备份 db 到 <db>.bak-orphan-repair-<时间戳>。
 *    幂等：重复运行安全（列存在性判断 + 存在性检查）。
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

(async () => {
  // 脚本在 scripts/ 下运行，项目根 = __dirname/..
  const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'main.db');
  if (!fs.existsSync(dbPath)) { console.log('未找到 db 文件，跳过:', dbPath); return; }

  // 备份
  const bak = dbPath + '.bak-orphan-repair-' + Date.now();
  fs.copyFileSync(dbPath, bak);
  console.log('[备份]', path.basename(bak));

  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  const run = (sql, params = []) => { db.run(sql, params); };
  const q = (sql, params = []) => {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };

  // ── 1. 确保 chats 有 name 列（幂等）──
  const cols = q('PRAGMA table_info(chats)').map(c => c.name);
  if (!cols.includes('name')) {
    run('ALTER TABLE chats ADD COLUMN name TEXT');
    console.log('[迁移] chats 表已补 name 列');
  } else {
    console.log('[迁移] chats 表已有 name 列，跳过');
  }

  // ── 2. 孤儿群补 owner ──
  const orphanGroups = q(
    `SELECT c.id, c.name FROM chats c
     WHERE c.type IN ('group','team')
       AND NOT EXISTS (SELECT 1 FROM participants p WHERE p.chat_id = c.id AND p.user_id IS NOT NULL)`
  );
  console.log('\n[孤儿群扫描] 共', orphanGroups.length, '个无用户参与者的群');
  let fixedOwner = 0, fixedName = 0;
  for (const g of orphanGroups) {
    // 找群内 agent 的归属用户（agent-u-* 真实平台用户 AI 助手优先）
    const ownerRows = q(
      `SELECT DISTINCT a.user_id FROM participants p
       JOIN agents a ON a.id = p.agent_id
       WHERE p.chat_id = ? AND p.agent_id IS NOT NULL
         AND a.user_id IS NOT NULL AND a.user_id != ''
       ORDER BY (CASE WHEN p.agent_id LIKE 'agent-u-%' THEN 0 ELSE 1 END), p.joined_at ASC`,
      [g.id]
    );
    if (ownerRows.length) {
      const ownerId = ownerRows[0].user_id;
      const pid = 'p-' + g.id + '-creator';
      const exists = q('SELECT id FROM participants WHERE id = ?', [pid]);
      if (!exists.length) {
        run('INSERT INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, NULL, ?, ?)',
          [pid, g.id, ownerId, 'owner', Date.now()]);
        console.log('[补 owner]', g.id, '->', ownerId, '(依据: 群内 AI 助手归属用户)');
        fixedOwner++;
      } else {
        console.log('[补 owner]', g.id, '已有 owner 行，跳过');
      }
    } else {
      console.log('[跳过]', g.id, '群内无可用 agent 归属用户，无法推断创建者，请人工处理');
    }
    // 名字：AGI进化组 明确回填；其他空名群提示
    if (!g.name && g.id === 'team-mt7qknoh') {
      run('UPDATE chats SET name = ? WHERE id = ?', ['AGI进化组', g.id]);
      console.log('[回填名字]', g.id, '-> AGI进化组');
      fixedName++;
    } else if (!g.name) {
      console.log('[提示]', g.id, '群名为空，可手动 UPDATE chats SET name=... WHERE id=...');
    }
  }

  // ── 3. smoke 群 type 归一 ──
  const smoke = q("SELECT id FROM chats WHERE type = 'team'");
  if (smoke.length) {
    run("UPDATE chats SET type = 'group' WHERE type = 'team'");
    console.log('\n[归一]', smoke.length, '个 type=team 的群已归一为 group:', smoke.map(s => s.id).join(', '));
  } else {
    console.log('\n[归一] 无 type=team 残留');
  }

  // ── 4. 幽灵参与者清理（两类）──
  const ghost1 = q('SELECT id FROM participants WHERE user_id IS NULL AND agent_id IS NULL');
  if (ghost1.length) {
    run('DELETE FROM participants WHERE user_id IS NULL AND agent_id IS NULL');
    console.log('[清理] 删除', ghost1.length, '条双空幽灵参与者行:', ghost1.map(x => x.id).join(', '));
  } else {
    console.log('[清理] 无双空幽灵参与者');
  }
  // 4b. chat_id 指向不存在群的行（群被删后残留）
  const ghost2 = q('SELECT id, chat_id FROM participants WHERE chat_id NOT IN (SELECT id FROM chats)');
  if (ghost2.length) {
    run('DELETE FROM participants WHERE chat_id NOT IN (SELECT id FROM chats)');
    console.log('[清理] 删除', ghost2.length, '条群已不存在的参与者行:', ghost2.map(x => x.id + '(' + x.chat_id + ')').join(', '));
  } else {
    console.log('[清理] 无群已不存在的参与者行');
  }

  // ── 写盘 ──
  const out = db.export();
  fs.writeFileSync(dbPath, Buffer.from(out));
  console.log('\n===== 修复完成 =====');
  console.log('补 owner:', fixedOwner, '| 回填名字:', fixedName, '| 备份:', path.basename(bak));
  console.log('现在可以启动服务，AGI进化组 会出现在会话列表。');
  db.close();
})();
