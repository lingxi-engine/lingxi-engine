/**
 * Patch: Add hires table + credit/hire CRUD to db.ts
 */
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'src', 'storage', 'db.ts');
let content = fs.readFileSync(dbPath, 'utf8');

// === 1. Insert hires table in _dbInit() ===
const marker1 = 'CREATE INDEX IF NOT EXISTS idx_lan_group_invites_user ON lan_group_invites(invited_user_id, status);';
const hireTableSQL = `
    -- 雇佣关系表
    CREATE TABLE IF NOT EXISTS hires (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      listing_title TEXT NOT NULL DEFAULT '',
      credits_paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',  -- active|fired|ended
      chat_group_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hires_buyer ON hires(buyer_id, status);
    CREATE INDEX IF NOT EXISTS idx_hires_seller ON hires(seller_id, status);
`;

let idx1 = content.indexOf(marker1);
if (idx1 === -1) { console.error('MARKER1 NOT FOUND'); process.exit(1); }
let afterIdx1 = content.indexOf('\n', idx1) + 1;
content = content.slice(0, afterIdx1) + hireTableSQL + content.slice(afterIdx1);
console.log('Inserted hires table in _dbInit()');

// === 2. Add CRUD functions ===
const marker2 = 'export function removeParticipant(chatId: string, userId: string, agentId?: string)';
const crudFunctions = `

// ── 雇佣系统：积分 CRUD ──

export function getUserCredits(userId: string): { credits: number; totalEarned: number; totalSpent: number } {
  const stmt = getDB().prepare('SELECT credits, total_earned, total_spent FROM user_credits WHERE user_id = ?');
  stmt.bind([userId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return { credits: row.credits || 0, totalEarned: row.total_earned || 0, totalSpent: row.total_spent || 0 };
  }
  stmt.free();
  const now = Date.now();
  getDB().run("INSERT OR IGNORE INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, 1000, 0, 0, ?)", [userId, now]);
  return { credits: 1000, totalEarned: 0, totalSpent: 0 };
}

export function addCredits(userId: string, amount: number): number {
  const now = Date.now();
  getDB().run(
    "INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ?",
    [userId, amount, amount, now, amount, amount, now]
  );
  return getUserCredits(userId).credits;
}

export function spendCredits(userId: string, amount: number): { ok: boolean; balance: number; error?: string } {
  const current = getUserCredits(userId);
  if (current.credits < amount) {
    return { ok: false, balance: current.credits, error: '积分不足' };
  }
  const now = Date.now();
  getDB().run(
    "UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?",
    [amount, amount, now, userId]
  );
  return { ok: true, balance: current.credits - amount };
}

// ── 雇佣系统：雇佣 CRUD ──

export function createHire(params: {
  id: string; listingId: string; buyerId: string; sellerId: string;
  listingTitle: string; creditsPaid: number; chatGroupId?: string;
}): any {
  const now = Date.now();
  getDB().run(
    "INSERT INTO hires (id, listing_id, buyer_id, seller_id, listing_title, credits_paid, status, chat_group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    [params.id, params.listingId, params.buyerId, params.sellerId, params.listingTitle, params.creditsPaid, params.chatGroupId || null, now, now]
  );
  return getHire(params.id);
}

export function getHire(id: string): any {
  return queryObjects("SELECT * FROM hires WHERE id = ?", [id])[0] || null;
}

export function fireHire(id: string): boolean {
  const hire = getHire(id);
  if (!hire) return false;
  getDB().run("UPDATE hires SET status = 'fired', updated_at = ? WHERE id = ?", [Date.now(), id]);
  return true;
}

export function listHiresByBuyer(buyerId: string, status?: string): any[] {
  if (status) {
    return queryObjects("SELECT * FROM hires WHERE buyer_id = ? AND status = ? ORDER BY created_at DESC", [buyerId, status]);
  }
  return queryObjects("SELECT * FROM hires WHERE buyer_id = ? ORDER BY created_at DESC", [buyerId]);
}

export function listHiresBySeller(sellerId: string, status?: string): any[] {
  if (status) {
    return queryObjects("SELECT * FROM hires WHERE seller_id = ? AND status = ? ORDER BY created_at DESC", [sellerId, status]);
  }
  return queryObjects("SELECT * FROM hires WHERE seller_id = ? ORDER BY created_at DESC", [sellerId]);
}
`;

let idx2 = content.indexOf(marker2);
if (idx2 === -1) { console.error('MARKER2 NOT FOUND'); process.exit(1); }
content = content.slice(0, idx2) + crudFunctions + '\n\n' + content.slice(idx2);
console.log('Inserted credit + hire CRUD functions');

// === 3. Add DB class methods ===
const marker3 = 'getLanGroupInviteByGroup(userId: string, groupId: string) { return getLanGroupInviteByGroup(userId, groupId); }';
const classMethods = `
  // ── 雇佣系统：积分 ──
  getUserCredits(userId: string) { return getUserCredits(userId); }
  addCredits(userId: string, amount: number) { return addCredits(userId, amount); }
  spendCredits(userId: string, amount: number) { return spendCredits(userId, amount); }
  // ── 雇佣系统：雇佣 ──
  createHire(params: any) { return createHire(params); }
  getHire(id: string) { return getHire(id); }
  fireHire(id: string) { return fireHire(id); }
  listHiresByBuyer(buyerId: string, status?: string) { return listHiresByBuyer(buyerId, status); }
  listHiresBySeller(sellerId: string, status?: string) { return listHiresBySeller(sellerId, status); }
`;

let idx3 = content.indexOf(marker3);
if (idx3 === -1) { console.error('MARKER3 NOT FOUND'); process.exit(1); }
let afterIdx3 = content.indexOf('\n', idx3) + 1;
content = content.slice(0, afterIdx3) + classMethods + content.slice(afterIdx3);
console.log('Inserted DB class methods');

fs.writeFileSync(dbPath, content, 'utf8');
console.log('DONE: db.ts patched successfully');
