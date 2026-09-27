/* [FEATURE_MARKET] 市场功能已暂时下线：所有市场接口已 404，脚本整体短路 */
if (true) { try { location.replace('/app/'); } catch (e) {} throw new Error('market disabled'); }
// market.js - 灵犀市场 v2.3.1 多品类版
// 品类: AI员工 / 音乐成品 / 视频成品 / 漏洞悬赏 / 游戏素材 / MCP服务 / 技能包

// ── 品类配置 ──
const MARKET_TYPES = {
  agent:  { label: 'AI员工',   icon: '🤖', color: '#4f8cff', desc: '发布你的 AI 员工到市场供人雇佣' },
  music:  { label: '音乐成品', icon: '🎵', color: '#ff6b9d', desc: '发布成品音乐，支持试听 / 卖版权' },
  video:  { label: '视频成品', icon: '🎬', color: '#9b59b6', desc: '发布成品视频，支持试看 / 卖版权' },
  bounty: { label: '漏洞悬赏', icon: '🛡️', color: '#e74c3c', desc: '悬赏挖漏洞 / 安全测试，让 AI 帮你找茬' },
  asset:  { label: '游戏素材', icon: '🎮', color: '#2ecc71', desc: '模型 / 贴图 / 音效 / 代码素材交易' },
  mcp:    { label: 'MCP服务',  icon: '🔌', color: '#00bcd4', desc: '发布 MCP Server，别人一键接入' },
  skill:  { label: '技能包',   icon: '🧩', color: '#f39c12', desc: '发布工作流 / 技能 / Prompt 模板' },
};
const TYPE_KEYS = Object.keys(MARKET_TYPES);

// ── 当前用户（不再 fallback 到 admin！）──
function currentUserId() {
  return localStorage.getItem('userId') || localStorage.getItem('lingxi-user-id') || '';
}
function currentDisplayName() {
  return localStorage.getItem('displayName') || '';
}
function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const tk = localStorage.getItem('authToken');
  if (tk) h['Authorization'] = 'Bearer ' + tk;
  return h;
}

const USER_ID = currentUserId();
let currentTab = 'market';
let currentType = '';            // '' = 全部
let pendingHire = null;
let wallet = { balanceUsd: 0, balanceCny: 0 };
let _listingCache = {};
let editModalListingId = null;
let pendingRateOrderId = null;

// ── 时长显示 ──
function fmtDuration(l) {
  const dur = Number(l && l.duration) || 0;
  if (dur <= 0 || !l.duration_unit || l.duration_unit === 'permanent') return '永久买断';
  const unitMap = { minute: '分钟', hour: '小时', day: '天' };
  return `${dur} ${unitMap[l.duration_unit] || '小时'}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  updateUserBar();
  await refreshCredits();
  await refreshWallet();
  const _t = new URLSearchParams(location.search).get('tab');
  const _ty = new URLSearchParams(location.search).get('type');
  if (_ty && MARKET_TYPES[_ty]) currentType = _ty;
  if (_t === 'mylistings' || _t === 'employees') switchTab(_t);
  else await loadMarket();
  const cs = document.getElementById('connStatus');
  if (cs) { cs.textContent = '🟢 已连接'; cs.style.color = '#4CAF50'; }
});

function updateUserBar() {
  const bar = document.getElementById('userBar');
  if (!bar) return;
  if (USER_ID) {
    bar.innerHTML = `👤 <b>${esc(currentDisplayName() || USER_ID)}</b> <a href="#" onclick="logoutMarket();return false" style="color:#e74c3c;font-size:12px;margin-left:10px">退出</a>`;
    bar.style.display = '';
  } else {
    bar.innerHTML = `<span style="color:#e67e22">⚠️ 未登录，请先在首页登录后再发布/雇佣</span>`;
    bar.style.display = '';
  }
}

async function logoutMarket() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }); } catch (e) {}
  localStorage.removeItem('authToken');
  localStorage.removeItem('userId');
  localStorage.removeItem('displayName');
  alert('✅ 已退出登录');
  location.reload();
}

// ── Tab 切换 ──
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('tab-market').style.display = tab === 'market' ? '' : 'none';
  document.getElementById('tab-mylistings').style.display = tab === 'mylistings' ? '' : 'none';
  document.getElementById('tab-employees').style.display = tab === 'employees' ? '' : 'none';
  if (tab === 'market') loadMarket();
  if (tab === 'mylistings') loadMyListings();
  if (tab === 'employees') loadEmployees();
}

// ── 品类 tab ──
function switchType(type) {
  currentType = type;
  document.querySelectorAll('.type-tab').forEach(t => t.classList.toggle('active', t.dataset.type === type));
  loadMarket();
}

function renderTypeTabs() {
  const el = document.getElementById('typeTabs');
  if (!el) return;
  el.innerHTML = `<button class="type-tab ${currentType === '' ? 'active' : ''}" data-type="" onclick="switchType('')">🏪 全部</button>` +
    TYPE_KEYS.map(k => `<button class="type-tab ${currentType === k ? 'active' : ''}" data-type="${k}" onclick="switchType('${k}')">${MARKET_TYPES[k].icon} ${MARKET_TYPES[k].label}</button>`).join('');
}

// ── 积分 ──
async function refreshCredits() {
  try {
    const r = await fetch(`/api/credits/balance?userId=${USER_ID}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) {
      const el = document.getElementById('creditsDisplay');
      el.style.display = 'inline-block';
      el.textContent = `🪙 ${d.credits} 积分`;
    }
  } catch (e) {}
}

// 💰 钱包（USD/CNY）
async function refreshWallet() {
  try {
    const r = await fetch(`/api/wallet?userId=${USER_ID}`, { headers: authHeaders() });
    const d = await r.json();
    if (d.ok) {
      wallet = { balanceUsd: Number(d.balanceUsd) || 0, balanceCny: Number(d.balanceCny) || 0 };
      const el = document.getElementById('walletDisplay');
      if (el) {
        el.style.display = 'inline-block';
        el.textContent = `💰 $${wallet.balanceUsd.toFixed(2)} / ¥${wallet.balanceCny.toFixed(2)}`;
      }
    }
  } catch (e) {}
}

function curSymbol(cur) {
  if (cur === 'usd') return '$';
  if (cur === 'cny') return '¥';
  return '🪙';
}
function curName(cur) {
  if (cur === 'usd') return '美元';
  if (cur === 'cny') return '人民币';
  return '积分';
}

// ➕ 充值（模拟）
function openRecharge() {
  if (!USER_ID) return alert('⚠️ 请先登录');
  document.getElementById('rechargeModal').style.display = 'flex';
}
function closeRecharge() {
  document.getElementById('rechargeModal').style.display = 'none';
}
async function doRecharge() {
  const currency = document.getElementById('rechargeCurrency').value;
  const amount = parseFloat(document.getElementById('rechargeAmount').value);
  if (!(amount > 0)) return alert('请输入有效金额');
  try {
    const r = await fetch('/api/wallet/recharge', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ userId: USER_ID, currency, amount }),
    });
    const d = await r.json();
    if (d.ok) {
      alert(`✅ ${curName(currency)} ${amount} 充值成功（模拟，未产生真实扣款）`);
      closeRecharge();
      await refreshWallet();
      await refreshCredits();
    } else alert('❌ ' + (d.error || '充值失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

// 发布表单币种切换
function onCurrencyChange() {
  const c = document.getElementById('pubCurrency').value;
  const lbl = document.getElementById('pubPriceLabel');
  if (c === 'usd') lbl.textContent = '价格（美元，最低 0.1）';
  else if (c === 'cny') lbl.textContent = '价格（人民币，最低 1）';
  else lbl.textContent = '价格（积分，最低 10）';
}

// ── 市场列表 ──
async function loadMarket() {
  renderTypeTabs();
  const grid = document.getElementById('listingGrid');
  grid.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  try {
    const url = currentType ? `/api/market/list?type=${currentType}` : '/api/market/list';
    const r = await fetch(url, { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { grid.innerHTML = `<div class="empty-state">❌ ${esc(d.error || '加载失败')}</div>`; return; }
    if (!d.listings || d.listings.length === 0) {
      grid.innerHTML = `<div class="empty-state">📭 该品类还没有商品，<a href="#" onclick="openPublish();return false" style="color:#4f8cff">点击发布第一个 →</a></div>`;
      return;
    }
    const balance = await (await fetch(`/api/credits/balance?userId=${USER_ID}`, { headers: authHeaders() })).json();
    const credits = balance.ok ? balance.credits : 0;
    grid.innerHTML = d.listings.map(l => {
      const t = MARKET_TYPES[l.item_type] || MARKET_TYPES.agent;
      const isMine = String(l.publisher_id) === String(USER_ID);
      const previewBtn = l.preview_url
        ? (l.item_type === 'music' || l.item_type === 'video'
            ? `<button class="btn-preview" onclick="previewMedia('${esc(l.preview_url)}','${t.label}')">▶ 试${l.item_type === 'music' ? '听' : '看'}</button>`
            : `<button class="btn-preview" onclick="window.open('${esc(l.preview_url)}','_blank')">🔗 预览</button>`)
        : '';
      return `
      <div class="listing-card" style="border-top:3px solid ${t.color}">
        <div class="lc-head">
          <span class="lc-icon" style="background:${t.color}1a">${t.icon}</span>
          <div class="lc-title">
            <h4>${esc(l.title)} <span class="lc-type" style="color:${t.color}">${t.label}</span></h4>
            <p>${esc(l.description || '暂无描述')}</p>
          </div>
        </div>
        <div class="lc-tags">${renderTags(l.tags)}</div>
        <div class="lc-meta">
          <span class="listing-price">${curSymbol(l.currency)} ${l.price || 0}${l.currency === "credits" ? " 积分" : " " + curName(l.currency)}</span>
          <span class="lc-sub">${l.item_type === 'agent' ? fmtDuration(l) : (l.license || '授权:待定')}</span>
          <span class="lc-sub">🔥 ${l.hire_count || 0} 次交易</span>
          ${l.rating ? `<span class="lc-sub">⭐ ${l.rating}</span>` : ''}
        </div>
        <div class="lc-actions">
          ${previewBtn}
          ${isMine
            ? `<button class="mgr-btn" onclick="openEditListing('${l.id}')">✏️ 编辑</button>`
            : `<button class="hire-btn" onclick="showHireConfirm('${l.id}','${esc(l.title)}',${l.price || 0},'${l.currency || 'credits'}')">${l.item_type === 'bounty' ? '🛡️ 接单' : '🤝 购买/雇佣'}</button>`}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">❌ 加载失败: ${esc(e.message)}</div>`;
  }
}

function renderTags(tags) {
  try {
    const arr = JSON.parse(tags || '[]');
    return arr.map(t => `<span class="tag">${esc(t)}</span>`).join('');
  } catch (e) { return ''; }
}

function previewMedia(url, label) {
  const m = document.getElementById('mediaModal');
  const body = document.getElementById('mediaModalBody');
  const isVideo = /\.(mp4|webm|mov|m3u8)/i.test(url) || url.includes('video');
  body.innerHTML = isVideo
    ? `<video src="${esc(url)}" controls autoplay style="max-width:100%;max-height:60vh;border-radius:10px"></video>`
    : `<audio src="${esc(url)}" controls autoplay style="width:100%"></audio>`;
  m.style.display = 'flex';
}

function closeMediaModal() {
  const m = document.getElementById('mediaModal');
  m.style.display = 'none';
  document.getElementById('mediaModalBody').innerHTML = '';
}

// ── 发布 ──
function openPublish() {
  if (!USER_ID) { alert('⚠️ 请先在首页登录后再发布'); return; }
  document.getElementById('publishModal').style.display = 'flex';
}
function closePublish() {
  document.getElementById('publishModal').style.display = 'none';
}
function onTypeChange() {
  const t = document.getElementById('pubItemType').value;
  document.getElementById('pubAgentRow').style.display = t === 'agent' ? '' : 'none';
  document.getElementById('pubMediaRow').style.display = (t === 'music' || t === 'video') ? '' : 'none';
  document.getElementById('pubFileRow').style.display = ['asset', 'mcp', 'skill', 'music', 'video'].includes(t) ? '' : 'none';
  document.getElementById('pubLicenseRow').style.display = ['music', 'video', 'asset', 'skill'].includes(t) ? '' : 'none';
  document.getElementById('pubHint').textContent = MARKET_TYPES[t].desc;
}

async function publishAgent() {
  if (!USER_ID) return alert('⚠️ 请先登录');
  const itemType = document.getElementById('pubItemType').value;
  const title = document.getElementById('pubTitle').value.trim();
  const price = parseFloat(document.getElementById('pubPrice').value) || 0;
  const currency = document.getElementById('pubCurrency').value;
  const category = document.getElementById('pubCategory').value;
  const description = document.getElementById('pubDesc').value.trim();
  const tags = document.getElementById('pubTags').value.split(',').map(s => s.trim()).filter(Boolean);
  const agentId = document.getElementById('pubAgentId').value.trim();
  const duration = parseInt(document.getElementById('pubDuration').value) || 0;
  const durationUnit = document.getElementById('pubDurationUnit').value;
  const previewUrl = document.getElementById('pubPreviewUrl').value.trim();
  const fileUrl = document.getElementById('pubFileUrl').value.trim();
  const license = document.getElementById('pubLicense').value.trim();
  if (!title) return alert('请输入商品名称');
  if (itemType === 'agent' && !agentId) return alert('请输入 Agent ID');
  const body = {
    agentId: agentId || USER_ID, publisherId: USER_ID, title, description, category, price, currency, tags,
    duration, durationUnit, itemType, previewUrl, fileUrl, license,
  };
  try {
    const r = await fetch('/api/market/publish', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) {
      alert('✅ 发布成功！');
      closePublish();
      ['pubTitle', 'pubDesc', 'pubTags', 'pubAgentId', 'pubPreviewUrl', 'pubFileUrl', 'pubLicense'].forEach(id => document.getElementById(id).value = '');
      loadMarket();
    } else alert('❌ ' + (d.error || '发布失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

// ── 雇佣/购买弹窗 ──
function showHireConfirm(listingId, title, price, cur) {
  if (!USER_ID) return alert('⚠️ 请先登录');
  cur = cur || 'credits';
  const sym = curSymbol(cur);
  let curBal = 0, curNameStr = curName(cur);
  if (cur === 'usd') curBal = wallet.balanceUsd;
  else if (cur === 'cny') curBal = wallet.balanceCny;
  else curBal = parseInt(document.getElementById('creditsDisplay').textContent.replace(/[^0-9]/g, '')) || 0;
  if (curBal < price) return alert(`❌ ${curNameStr}不足！需要 ${sym}${price}，当前 ${sym}${curBal}`);
  pendingHire = { listingId, price, currency: cur };
  document.getElementById('hireModalText').innerHTML =
    `确定要购买/雇佣 <strong>${esc(title)}</strong> 吗？<br>
     <span style="color:#f57c00">${sym === '🪙' ? '🪙 将扣除 ' + price + ' 积分' : '💳 将扣除 ' + sym + price + ' ' + curNameStr}</span><br>
     <span style="color:#888;font-size:12px">当前余额: ${cur === 'usd' ? '$' + wallet.balanceUsd.toFixed(2) : cur === 'cny' ? '¥' + wallet.balanceCny.toFixed(2) : curBal + ' 积分'}</span>`;
  document.getElementById('hireModal').style.display = 'flex';
}

function closeHireModal() {
  pendingHire = null;
  document.getElementById('hireModal').style.display = 'none';
}

async function confirmHire() {
  if (!pendingHire) return;
  const { listingId } = pendingHire;
  document.getElementById('hireModal').style.display = 'none';
  try {
    const r = await fetch('/api/market/hire', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ listingId, buyerId: USER_ID }),
    });
    const d = await r.json();
    if (d.ok) {
      alert(`✅ 交易成功！已扣除 ${curSymbol(pendingHire.currency)}${pendingHire.price}${pendingHire.currency === 'credits' ? ' 积分' : ' ' + curName(pendingHire.currency)}。${d.chatId ? '工作群已创建。' : ''}`);
      await refreshCredits();
      await refreshWallet();
      loadMarket();
    } else alert('❌ ' + (d.error || '交易失败'));
  } catch (e) { alert('❌ ' + e.message); }
  pendingHire = null;
}

// ── 我的发布 ──
async function loadMyListings() {
  const grid = document.getElementById('myListingsGrid');
  grid.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  if (!USER_ID) { grid.innerHTML = '<div class="empty-state">⚠️ 未登录，无法查看我的发布</div>'; return; }
  try {
    const r = await fetch(`/api/market/my-listings?userId=${USER_ID}`, { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { grid.innerHTML = `<div class="empty-state">❌ ${esc(d.error || '加载失败')}</div>`; return; }
    if (!d.listings || d.listings.length === 0) {
      grid.innerHTML = '<div class="empty-state">📭 你还没有发布过商品，点击"市场"页发布第一个！</div>';
      return;
    }
    _listingCache = {};
    grid.innerHTML = d.listings.map(l => {
      _listingCache[l.id] = l;
      const t = MARKET_TYPES[l.item_type] || MARKET_TYPES.agent;
      const isActive = l.status === 'active';
      const badge = isActive ? '<span class="status-badge status-active">上架中</span>' : '<span class="status-badge status-paused">已下架</span>';
      return `
      <div class="listing-card" style="border-top:3px solid ${t.color}">
        <div class="lc-head">
          <span class="lc-icon" style="background:${t.color}1a">${t.icon}</span>
          <div class="lc-title">
            <h4>${esc(l.title)} ${badge} <span class="lc-type" style="color:${t.color}">${t.label}</span></h4>
            <p>${esc(l.description || '暂无描述')}</p>
          </div>
        </div>
        <div class="lc-meta">
          <span class="listing-price">${curSymbol(l.currency)} ${l.price || 0}${l.currency === "credits" ? " 积分" : " " + curName(l.currency)}</span>
          <span class="lc-sub">${l.item_type === 'agent' ? fmtDuration(l) : (l.license || '授权:待定')}</span>
          <span class="lc-sub">🔥 ${l.hire_count || 0} 次交易</span>
        </div>
        <div class="listing-actions">
          ${isActive ? `<button class="mgr-btn" onclick="unpublishListing('${l.id}')">下架</button>` : `<button class="mgr-btn ok" onclick="republishListing('${l.id}')">重新上架</button>`}
          <button class="mgr-btn" onclick="openEditListing('${l.id}')">✏️ 编辑</button>
          <button class="mgr-btn danger" onclick="deleteListing('${l.id}')">🗑 删除</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">❌ ${esc(e.message)}</div>`;
  }
}

async function unpublishListing(listingId) {
  if (!confirm('确定要下架该商品吗？')) return;
  try {
    const r = await fetch('/api/market/unpublish', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ listingId, userId: USER_ID }) });
    const d = await r.json();
    if (d.ok) { alert('✅ 已下架'); loadMyListings(); } else alert('❌ ' + (d.error || '下架失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

async function republishListing(listingId) {
  try {
    const r = await fetch('/api/market/republish', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ listingId, userId: USER_ID }) });
    const d = await r.json();
    if (d.ok) { alert('✅ 已重新上架'); loadMyListings(); } else alert('❌ ' + (d.error || '上架失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

async function deleteListing(listingId) {
  if (!confirm('确定要删除该发布吗？删除后不可恢复。')) return;
  try {
    const r = await fetch(`/api/market/${listingId}?userId=${USER_ID}`, { method: 'DELETE', headers: authHeaders() });
    const d = await r.json();
    if (d.ok) { alert('✅ 已删除'); loadMyListings(); } else alert('❌ ' + (d.error || '删除失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

// ── 编辑 ──
function openEditListing(listingId) {
  const l = _listingCache[listingId];
  if (!l) return;
  document.getElementById('editTitle').value = l.title || '';
  document.getElementById('editDesc').value = l.description || '';
  const catSel = document.getElementById('editCategory');
  [...catSel.options].forEach(o => { if (o.value === (l.category || '通用')) o.selected = true; });
  document.getElementById('editPrice').value = l.price || 0;
  const ec = document.getElementById('editCurrency');
  if (ec) ec.value = l.currency || 'credits';
  document.getElementById('editDuration').value = Number(l.duration) || 0;
  document.getElementById('editDurationUnit').value = ['minute', 'hour', 'day', 'permanent'].includes(l.duration_unit) ? l.duration_unit : 'permanent';
  document.getElementById('editPreviewUrl').value = l.preview_url || '';
  document.getElementById('editFileUrl').value = l.file_url || '';
  document.getElementById('editLicense').value = l.license || '';
  editModalListingId = listingId;
  document.getElementById('editModal').style.display = 'flex';
}

function closeEditModal() {
  editModalListingId = null;
  document.getElementById('editModal').style.display = 'none';
}

async function submitEditListing() {
  if (!editModalListingId) return;
  const title = document.getElementById('editTitle').value.trim();
  if (!title) return alert('请输入商品名称');
  const body = {
    userId: USER_ID, title,
    description: document.getElementById('editDesc').value.trim(),
    category: document.getElementById('editCategory').value,
    price: parseInt(document.getElementById('editPrice').value) || 0,
    duration: parseInt(document.getElementById('editDuration').value) || 0,
    durationUnit: document.getElementById('editDurationUnit').value,
    previewUrl: document.getElementById('editPreviewUrl').value.trim(),
    fileUrl: document.getElementById('editFileUrl').value.trim(),
    license: document.getElementById('editLicense').value.trim(),
  };
  try {
    const r = await fetch(`/api/market/${editModalListingId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { alert('✅ 已保存'); closeEditModal(); loadMyListings(); } else alert('❌ ' + (d.error || '保存失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

// ── 评价 ──
function showRateModal(orderId) {
  pendingRateOrderId = orderId;
  document.getElementById('rateReview').value = '';
  document.getElementById('rateModal').style.display = 'flex';
}
function closeRateModal() {
  pendingRateOrderId = null;
  document.getElementById('rateModal').style.display = 'none';
}
async function submitRate() {
  if (!pendingRateOrderId) return;
  const rating = parseInt(document.getElementById('rateScore').value) || 0;
  const review = document.getElementById('rateReview').value.trim();
  try {
    const r = await fetch('/api/market/rate', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ orderId: pendingRateOrderId, rating, review, userId: USER_ID }) });
    const d = await r.json();
    if (d.ok) { alert('✅ 评价成功，感谢反馈！'); closeRateModal(); loadEmployees(); } else alert('❌ ' + (d.error || '评价失败'));
  } catch (e) { alert('❌ ' + e.message); }
}

// ── 员工管理 ──
async function loadEmployees() {
  const myEl = document.getElementById('myEmployees');
  const hiredEl = document.getElementById('hiredMe');
  myEl.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  hiredEl.innerHTML = '';
  if (!USER_ID) { myEl.innerHTML = '<div class="empty-state">⚠️ 未登录，无法查看员工</div>'; return; }
  try {
    const r = await fetch(`/api/employees?userId=${USER_ID}`, { headers: authHeaders() });
    const d = await r.json();
    if (!d.ok) { myEl.innerHTML = `<div class="empty-state">❌ ${esc(d.error)}</div>`; return; }
    if (!d.asBuyer || d.asBuyer.length === 0) {
      myEl.innerHTML = '<div class="empty-state">📭 还没有雇佣过 AI 员工</div>';
    } else {
      myEl.innerHTML = d.asBuyer.map(h => {
        const listing = h.listing || {};
        const isActive = h.status === 'active';
        const isExpired = h.status === 'expired';
        const badge = isActive ? '<span class="status-badge status-active">工作中</span>'
          : isExpired ? '<span class="status-badge status-expired">已到期</span>'
          : '<span class="status-badge status-terminated">已解雇</span>';
        const expireInfo = Number(h.expires_at) > 0 ? ` | 到期 ${new Date(h.expires_at).toLocaleString()}` : ' | 永久';
        return `
          <div class="employee-card">
            <div class="employee-info">
              <h4>${esc(listing.title || 'AI员工')} ${badge}</h4>
              <p>🪙 ${h.price || 0} 积分 | ${esc(listing.category || '通用')} | 雇佣于 ${new Date(h.hired_at).toLocaleDateString()}${isActive ? expireInfo : ''}</p>
            </div>
            <div class="employee-actions">
              ${isActive ? `<a href="/?chat=${h.chat_id}" class="chat-btn" target="_blank">💬 工作群</a>` : ''}
              ${isActive ? `<button class="fire-btn" onclick="fireEmployee('${h.id}')">解雇</button>` : ''}
              ${h.orderId && !h.rated ? `<button class="rate-btn" onclick="showRateModal('${h.orderId}')">⭐ 评价</button>` : ''}
            </div>
          </div>`;
      }).join('');
    }
    if (!d.asSeller || d.asSeller.length === 0) {
      hiredEl.innerHTML = '<div class="empty-state">📭 还没有人雇佣你的员工</div>';
    } else {
      hiredEl.innerHTML = d.asSeller.map(h => {
        const listing = h.listing || {};
        const isActive = h.status === 'active';
        return `
          <div class="employee-card">
            <div class="employee-info">
              <h4>${esc(listing.title || 'AI员工')} ${isActive ? '<span class="status-badge status-active">服务中</span>' : '<span class="status-badge status-terminated">已终止</span>'}</h4>
              <p>🪙 ${h.price || 0} 积分 | 雇佣者ID: ${esc(h.buyer_id)}</p>
            </div>
            <div class="employee-actions">
              ${isActive ? `<a href="/?chat=${h.chat_id}" class="chat-btn" target="_blank">💬 工作群</a>` : ''}
            </div>
          </div>`;
      }).join('');
    }
  } catch (e) {
    myEl.innerHTML = `<div class="empty-state">❌ ${esc(e.message)}</div>`;
  }
}

async function fireEmployee(hireId) {
  if (!confirm('确定要解雇该员工吗？')) return;
  try {
    const r = await fetch('/api/employees/fire', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ hireId }) });
    const d = await r.json();
    if (d.ok) { alert('✅ 已解雇'); loadEmployees(); } else alert('❌ ' + (d.error || '解雇失败'));
  } catch (e) { alert('❌ ' + e.message); }
}
