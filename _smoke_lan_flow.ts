/**
 * LAN 群组流程修复冒烟测试 v3（tsx 运行）
 */
import { initDB, createLanGroup, getLanGroup, addLanGroupMember, getLanGroupMembers, upsertLanRemoteIdentity, getDB } from './src/storage/db.js';
import { LanSocialHub } from './src/net/lan-social.js';
import { getLanInstanceId } from './src/net/lan-discovery.js';
import { unlinkSync } from 'fs';

let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) console.log('  ✅ ' + name);
  else { console.log('  ❌ ' + name); failed++; }
}

async function main() {
  const dbPath = './data/_smoke_lan_flow_test.db';
  try { unlinkSync(dbPath); } catch {}
  await initDB(dbPath);

  const myInst = getLanInstanceId(); // 未启动 discovery 时为 ''，两边一致即可

  // 可变用户数组（构造函数持有数组引用，后续 push 生效）
  const users: any[] = [
    { id: 'user-1', numericId: 10001, displayName: '张三', agentId: 'agent-1' },
    { id: 'user-2', numericId: 10002, displayName: '李四', agentId: 'agent-2' },
  ];
  const deps = {
    router: {} as any,
    manager: {} as any,
    broadcast: () => {},
    getLocalUsers: () => users,
  };
  const hub = new LanSocialHub(deps as any);

  // 准备：agents 表插入 user-1 的 agent（测本地回填）
  const db = getDB();
  db.run("INSERT INTO agents (id, user_id, display_name, model, created_at) VALUES ('agent-1', 'user-1', '张三的智能体', '', ?)", [Date.now()]);

  console.log('\n[1] Bug A: createLanGroup 参数落库');
  createLanGroup('lg-smoke1', '测试群', myInst, 'owner-1', 'debate');
  const g = getLanGroup('lg-smoke1');
  console.log('  落库结果:', JSON.stringify({ owner_user_id: g.owner_user_id, chat_mode: g.chat_mode }));
  assert(g.owner_user_id === 'owner-1', 'owner_user_id 应为 owner-1（不再被 chatMode 污染）');
  assert(g.chat_mode === 'debate', 'chat_mode 应为 debate（不再静默丢失）');
  createLanGroup('lg-smoke2', '默认模式群', myInst, 'owner-1');
  const g2 = getLanGroup('lg-smoke2');
  assert(g2.chat_mode === 'free' && g2.owner_user_id === 'owner-1', '默认 chat_mode=free 且 owner_user_id 正常');

  console.log('\n[2] 成员落库');
  addLanGroupMember({ groupId: 'lg-smoke1', userId: 'user-1', numericId: 10001, displayName: '张三', instanceId: myInst });
  addLanGroupMember({ groupId: 'lg-smoke1', userId: 'user-2', numericId: 10002, displayName: '李四', instanceId: 'inst-B' });
  const ms = getLanGroupMembers('lg-smoke1');
  assert(ms.length === 2, '成员数=2');
  assert(ms[0].display_name === '张三', '成员 display_name 落库');

  console.log('\n[3] getGroup 字段映射');
  upsertLanRemoteIdentity({ userId: 'user-2', instanceId: 'inst-B', numericId: 10002, displayName: '李四', agentId: 'agent-2' });
  const gg = hub.getGroup('lg-smoke1');
  assert(!!gg, 'getGroup 返回群');
  assert(gg.chatMode === 'debate', 'chatMode 字段');
  assert(gg.humanChatId === 'langroup-lg-smoke1-human', 'humanChatId');
  assert(gg.agentChatId === 'langroup-lg-smoke1-agents', 'agentChatId');
  const m0 = gg.members.find((m: any) => m.userId === 'user-1');
  const m1 = gg.members.find((m: any) => m.userId === 'user-2');
  assert(m0.displayName === '张三', 'displayName camelCase（前端不再 undefined）');
  assert(m0.numericId === 10001, 'numericId camelCase');
  assert(m0.instanceId === myInst, 'instanceId camelCase');
  assert(typeof m0.online === 'boolean' && typeof m0.local === 'boolean', 'online/local 布尔');
  assert(m0.agentId === 'agent-1', 'agentId 本地回填（agents 表）成功');
  assert(m1.agentId === 'agent-2', 'agentId 远程回填（lan_remote_identities）成功');

  console.log('\n[4] addGroupMember（建群后加人）');
  const r1 = await hub.addGroupMember('lg-smoke1', 10001);
  assert(r1.ok && r1.note === '已是群成员', '已是群成员不重复添加');
  users.push({ id: 'user-3', numericId: 10003, displayName: '王五', agentId: 'agent-3' });
  const r2 = await hub.addGroupMember('lg-smoke1', 10003);
  assert(r2.ok && r2.member && r2.member.displayName === '王五', '新成员添加成功: ' + JSON.stringify(r2.member));
  assert(getLanGroupMembers('lg-smoke1').length === 3, '成员数变为 3');
  try {
    await hub.addGroupMember('lg-smoke1', 99999);
    assert(false, '不存在的 ID 应抛错');
  } catch (e: any) {
    assert(e.message.includes('未找到数字 ID'), '不存在的 ID 正确抛错: ' + e.message);
  }

  console.log('\n[5] handleGroupInvite 精确匹配');
  const ri = hub.handleGroupInvite({
    group: { id: 'lg-x1', name: '外部群', ownerInstance: 'inst-B' },
    members: [{ userId: 'user-9', numericId: 10009, displayName: '赵六', instanceId: 'inst-B' }],
  });
  assert(ri.pending === false && ri.note === '未匹配到本机用户', '不匹配本机用户时忽略: ' + JSON.stringify(ri));
  const ri2 = hub.handleGroupInvite({
    group: { id: 'lg-x2', name: '邀请群', ownerInstance: 'inst-B' },
    members: [
      { userId: 'user-9', numericId: 10009, displayName: '赵六', instanceId: 'inst-B' },
      { userId: 'user-3', numericId: 10003, displayName: '王五', instanceId: 'inst-B' },
    ],
  });
  assert(ri2.pending === true, '匹配本机用户时进入待确认: ' + JSON.stringify(ri2));

  console.log('\n[6] createGroup 容错');
  const r3 = await hub.createGroup('user-1', '容错测试群', [10001, 10099], 'free');
  console.log('  createGroup 结果:', JSON.stringify(r3));
  assert(r3.ok === true, '群照常创建（不再因单个成员失败整体中止）');
  assert(Array.isArray(r3.failedMembers) && r3.failedMembers.includes(10099), 'failedMembers 收集 10099');
  assert(r3.memberCount === 1, 'memberCount=1（user-1 与 10001 同人去重）');

  console.log(failed === 0 ? '\n🎉 冒烟测试全部通过' : `\n⚠️ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('冒烟测试异常:', e); process.exit(1); });
