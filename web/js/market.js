// market.js - AI员工市场 雇佣系统 完整版

const USER_ID = localStorage.getItem('userId') || 'admin';
let currentTab = 'market';
let pendingHire = null;
let _listingCache = {};       // 我的发布缓存 id -> listing
let editModalListingId = null;
let pendingRateOrderId = null;

// ── 时长显示 ──
function fmtDuration(l) {
  const dur = Number(l && l.duration) || 0;
  if (dur <= 0) return '永久';
  const unitMap = { minute: '分钟', hour: '小时', day: '天' };
  return `${dur} ${unitMap[l.duration_unit] || '小时'}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshCredits();
  // 支持 ?tab=mylistings|employees 直达
  const _t = new URLSearchParams(location.search).get('tab');
  if (_t === 'mylistings' || _t === 'employees') switchTab(_t);
  else await loadMarket();
  document.getElementById('connStatus').textContent = '🟢 已连接';
  document.getElementById('connStatus').style.color = '#4CAF50';
});

// ── Tab 切换 ──
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.textContent.includes(
    tab === 'market' ? '市场' : tab === 'mylistings' ? '发布' : '员工'
  )));
  document.getElementById('tab-market').style.display = tab === 'market' ? '' : 'none';
  document.getElementById('tab-mylistings').style.display = tab === 'mylistings' ? '' : 'none';
  document.getElementById('tab-employees').style.display = tab === 'employees' ? '' : 'none';
  if (tab === 'market') loadMarket();
  if (tab === 'mylistings') loadMyListings();
  if (tab === 'employees') loadEmployees();
}

// ── 积分 ──
async function refreshCredits() {
  try {
    const r = await fetch(`/api/credits/balance?userId=${USER_ID}`);
    const d = await r.json();
    if (d.ok) {
      const el = document.getElementById('creditsDisplay');
      el.style.display = 'inline-block';
      el.textContent = `🪙 ${d.credits} 积分`;
    }
  } catch(e) {}
}

// ── 市场列表 ──
async function loadMarket() {
  const grid = document.getElementById('listingGrid');
  grid.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  try {
    const r = await fetch('/api/market/list');
    const d = await r.json();
    if (!d.ok) { grid.innerHTML = `<div class="empty-state">❌ ${d.error}</div>`; return; }
    if (!d.listings || d.listings.length === 0) {
      grid.innerHTML = '<div class="empty-state">📭 市场中还没有AI员工，快去发布吧！</div>';
      return;
    }
    const balance = await (await fetch(`/api/credits/balance?userId=${USER_ID}`)).json();
    const credits = balance.ok ? balance.credits : 0;
    grid.innerHTML = d.listings.map(l => `
      <div class="listing-card">
        <div>
          <h4>${l.title || '未命名'}</h4>
          <p>${l.description || '暂无描述'}</p>
          <span class="listing-price">🪙 ${l.price || 0} 积分 / ${fmtDuration(l)}</span>
          <span style="color:#888;font-size:11px;margin-left:8px">分类: ${l.category || '通用'}</span>
          <span style="color:#888;font-size:11px;margin-left:8px">已雇佣: ${l.hire_count || 0}次</span>
        </div>
        <div>
          <button class="hire-btn" onclick="window._hireDurText='${fmtDuration(l)}';showHireConfirm('${l.id}','${l.title || 'AI员工'}',${l.price||10},${credits})">雇佣</button>
        </div>
      </div>
    `).join('');
  } catch(e) {
    grid.innerHTML = `<div class="empty-state">❌ 加载失败: ${e.message}</div>`;
  }
}

// ── 发布 ──
async function publishAgent() {
  const agentId = document.getElementById('pubAgentId').value.trim();
  const title = document.getElementById('pubTitle').value.trim();
  const price = parseInt(document.getElementById('pubPrice').value) || 10;
  const duration = parseInt(document.getElementById('pubDuration').value) || 0;
  const durationUnit = document.getElementById('pubDurationUnit').value;
  const category = document.getElementById('pubCategory').value;
  const description = document.getElementById('pubDesc').value.trim();
  const tags = document.getElementById('pubTags').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!title) return alert('请输入员工名称');
  if (!agentId) return alert('请输入Agent ID');
  try {
    const r = await fetch('/api/market/publish', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ agentId, publisherId: USER_ID, title, description, category, price, tags, duration, durationUnit }),
    });
    const d = await r.json();
    if (d.ok) {
      alert('✅ 发布成功！');
      document.getElementById('pubAgentId').value = '';
      document.getElementById('pubTitle').value = '';
      document.getElementById('pubDesc').value = '';
      document.getElementById('pubTags').value = '';
      loadMarket();
    } else alert('❌ ' + (d.error || '发布失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

// ── 雇佣弹窗 ──
function showHireConfirm(listingId, title, price, credits) {
  if (price > credits) {
    return alert(`❌ 积分不足！需要 ${price} 积分，当前 ${credits} 积分`);
  }
  pendingHire = { listingId, price };
  document.getElementById('hireModalText').innerHTML =
    `确定要雇佣 <strong>${title}</strong> 吗？<br>
     <span style="color:#f57c00">🪙 将扣除 ${price} 积分</span><br>
     <span style="color:#888;font-size:12px">当前积分: ${credits}</span><br>
     <span style="color:#888;font-size:12px">服务时长: ${window._hireDurText || '永久'}</span>`;
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
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ listingId, buyerId: USER_ID }),
    });
    const d = await r.json();
    if (d.ok) {
      alert(`✅ 雇佣成功！已扣除 ${pendingHire.price} 积分。工作群已创建。`);
      await refreshCredits();
      loadMarket();
    } else {
      alert('❌ ' + (d.error || '雇佣失败'));
    }
  } catch(e) { alert('❌ ' + e.message); }
  pendingHire = null;
}

// ── 我的发布 ──
async function loadMyListings() {
  const grid = document.getElementById('myListingsGrid');
  grid.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  try {
    const r = await fetch(`/api/market/my-listings?userId=${USER_ID}`);
    const d = await r.json();
    if (!d.ok) { grid.innerHTML = `<div class="empty-state">❌ ${d.error}</div>`; return; }
    if (!d.listings || d.listings.length === 0) {
      grid.innerHTML = '<div class="empty-state">📭 你还没有发布过AI员工</div>';
      return;
    }
    _listingCache = {};
    grid.innerHTML = d.listings.map(l => {
      _listingCache[l.id] = l;
      const isActive = l.status === 'active';
      const badge = isActive
        ? '<span class="status-badge status-active">上架中</span>'
        : '<span class="status-badge status-paused">已下架</span>';
      return `
      <div class="listing-card">
        <div style="flex:1">
          <h4>${l.title || '未命名'} ${badge}</h4>
          <p>${l.description || '暂无描述'}</p>
          <span class="listing-price">🪙 ${l.price || 0} 积分 / ${fmtDuration(l)}</span>
          <span style="color:#888;font-size:11px;margin-left:8px">已雇佣: ${l.hire_count || 0}次</span>
          <span style="color:#888;font-size:11px;margin-left:8px">Agent: ${l.agent_id || '—'}</span>
          <div class="listing-actions">
            ${isActive
              ? `<button class="mgr-btn" onclick="unpublishListing('${l.id}')">下架</button>`
              : `<button class="mgr-btn ok" onclick="republishListing('${l.id}')">重新上架</button>`}
            <button class="mgr-btn" onclick="openEditListing('${l.id}')">编辑</button>
            <button class="mgr-btn danger" onclick="deleteListing('${l.id}')">删除</button>
          </div>
        </div>
      </div>
      `;
    }).join('');
  } catch(e) {
    grid.innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }
}

// ── 发布管理：下架 / 重新上架 / 删除 ──
async function unpublishListing(listingId) {
  if (!confirm('确定要下架该员工吗？')) return;
  try {
    const r = await fetch('/api/market/unpublish', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ listingId, userId: USER_ID }),
    });
    const d = await r.json();
    if (d.ok) { alert('✅ 已下架'); loadMyListings(); }
    else alert('❌ ' + (d.error || '下架失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

async function republishListing(listingId) {
  try {
    const r = await fetch('/api/market/republish', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ listingId, userId: USER_ID }),
    });
    const d = await r.json();
    if (d.ok) { alert('✅ 已重新上架'); loadMyListings(); }
    else alert('❌ ' + (d.error || '上架失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

async function deleteListing(listingId) {
  if (!confirm('确定要删除该发布吗？删除后不可恢复。')) return;
  try {
    const r = await fetch(`/api/market/${listingId}?userId=${USER_ID}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { alert('✅ 已删除'); loadMyListings(); }
    else alert('❌ ' + (d.error || '删除失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

// ── 编辑弹窗 ──
function openEditListing(listingId) {
  const l = _listingCache[listingId];
  if (!l) return;
  document.getElementById('editTitle').value = l.title || '';
  document.getElementById('editDesc').value = l.description || '';
  const catSel = document.getElementById('editCategory');
  [...catSel.options].forEach(o => { if (o.value === (l.category || '通用')) o.selected = true; });
  document.getElementById('editPrice').value = l.price || 10;
  document.getElementById('editDuration').value = Number(l.duration) || 0;
  document.getElementById('editDurationUnit').value = ['minute','hour','day'].includes(l.duration_unit) ? l.duration_unit : 'permanent';
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
  if (!title) return alert('请输入员工名称');
  const body = {
    userId: USER_ID,
    title,
    description: document.getElementById('editDesc').value.trim(),
    category: document.getElementById('editCategory').value,
    price: parseInt(document.getElementById('editPrice').value) || 0,
    duration: parseInt(document.getElementById('editDuration').value) || 0,
    durationUnit: document.getElementById('editDurationUnit').value,
  };
  try {
    const r = await fetch(`/api/market/${editModalListingId}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) { alert('✅ 已保存'); closeEditModal(); loadMyListings(); }
    else alert('❌ ' + (d.error || '保存失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

// ── 评价弹窗 ──
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
    const r = await fetch('/api/market/rate', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ orderId: pendingRateOrderId, rating, review, userId: USER_ID }),
    });
    const d = await r.json();
    if (d.ok) { alert('✅ 评价成功，感谢反馈！'); closeRateModal(); loadEmployees(); }
    else alert('❌ ' + (d.error || '评价失败'));
  } catch(e) { alert('❌ ' + e.message); }
}

// ── 员工管理 ──
async function loadEmployees() {
  const myEl = document.getElementById('myEmployees');
  const hiredEl = document.getElementById('hiredMe');
  myEl.innerHTML = '<div class="empty-state">⏳ 加载中...</div>';
  hiredEl.innerHTML = '';
  try {
    const r = await fetch(`/api/employees?userId=${USER_ID}`);
    const d = await r.json();
    if (!d.ok) { myEl.innerHTML = `<div class="empty-state">❌ ${d.error}</div>`; return; }
    
    // 我雇佣的员工
    if (!d.asBuyer || d.asBuyer.length === 0) {
      myEl.innerHTML = '<div class="empty-state">📭 还没有雇佣过AI员工</div>';
    } else {
      myEl.innerHTML = d.asBuyer.map(h => {
        const listing = h.listing || {};
        const isActive = h.status === 'active';
        const isExpired = h.status === 'expired';
        const badge = isActive
          ? '<span class="status-badge status-active">工作中</span>'
          : isExpired
            ? '<span class="status-badge status-expired">已到期</span>'
            : '<span class="status-badge status-terminated">已解雇</span>';
        const expireInfo = Number(h.expires_at) > 0
          ? ` | 到期 ${new Date(h.expires_at).toLocaleString()}`
          : ' | 永久';
        return `
          <div class="employee-card">
            <div class="employee-info">
              <h4>${listing.title || 'AI员工'} ${badge}</h4>
              <p>🪙 ${h.price || 0} 积分 | ${listing.category || '通用'} | 雇佣于 ${new Date(h.hired_at).toLocaleDateString()}${isActive ? expireInfo : ''}</p>
            </div>
            <div class="employee-actions">
              ${isActive ? `<a href="/?chat=${h.chat_id}" class="chat-btn" target="_blank">💬 工作群</a>` : ''}
              ${isActive ? `<button class="fire-btn" onclick="fireEmployee('${h.id}')">解雇</button>` : ''}
              ${h.orderId && !h.rated ? `<button class="rate-btn" onclick="showRateModal('${h.orderId}')">⭐ 评价</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }
    
    // 我被雇佣
    if (!d.asSeller || d.asSeller.length === 0) {
      hiredEl.innerHTML = '<div class="empty-state">📭 还没有人被你雇佣</div>';
    } else {
      hiredEl.innerHTML = d.asSeller.map(h => {
        const listing = h.listing || {};
        const isActive = h.status === 'active';
        return `
          <div class="employee-card">
            <div class="employee-info">
              <h4>${listing.title || 'AI员工'} ${isActive ? '<span class="status-badge status-active">服务中</span>' : '<span class="status-badge status-terminated">已终止</span>'}</h4>
              <p>🪙 ${h.price || 0} 积分 | 雇佣者ID: ${h.buyer_id}</p>
            </div>
            <div class="employee-actions">
              ${isActive ? `<a href="/?chat=${h.chat_id}" class="chat-btn" target="_blank">💬 工作群</a>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }
  } catch(e) {
    myEl.innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }
}

// ── 解雇 ──
async function fireEmployee(hireId) {
  if (!confirm('确定要解雇该员工吗？')) return;
  try {
    const r = await fetch('/api/employees/fire', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ hireId }),
    });
    const d = await r.json();
    if (d.ok) {
      alert('✅ 已解雇');
      loadEmployees();
    } else alert('❌ ' + (d.error || '解雇失败'));
  } catch(e) { alert('❌ ' + e.message); }
}
