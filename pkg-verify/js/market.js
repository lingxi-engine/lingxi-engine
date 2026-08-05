// market.js - AI员工市场 雇佣系统 完整版

const USER_ID = localStorage.getItem('userId') || 'admin';
let currentTab = 'market';
let pendingHire = null;

document.addEventListener('DOMContentLoaded', async () => {
  await refreshCredits();
  await loadMarket();
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
          <span class="listing-price">🪙 ${l.price || 0} 积分</span>
          <span style="color:#888;font-size:11px;margin-left:8px">分类: ${l.category || '通用'}</span>
          <span style="color:#888;font-size:11px;margin-left:8px">已雇佣: ${l.hire_count || 0}次</span>
        </div>
        <div>
          <button class="hire-btn" onclick="showHireConfirm('${l.id}','${l.title || 'AI员工'}',${l.price||10},${credits})">雇佣</button>
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
  const category = document.getElementById('pubCategory').value;
  const description = document.getElementById('pubDesc').value.trim();
  const tags = document.getElementById('pubTags').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!title) return alert('请输入员工名称');
  if (!agentId) return alert('请输入Agent ID');
  try {
    const r = await fetch('/api/market/publish', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ agentId, publisherId: USER_ID, title, description, category, price, tags }),
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
     <span style="color:#888;font-size:12px">当前积分: ${credits}</span>`;
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
    grid.innerHTML = d.listings.map(l => `
      <div class="listing-card">
        <div>
          <h4>${l.title || '未命名'}</h4>
          <p>${l.description || '暂无描述'}</p>
          <span class="listing-price">🪙 ${l.price || 0} 积分</span>
          <span style="color:#888;font-size:11px;margin-left:8px">已雇佣: ${l.hire_count || 0}次</span>
          <span style="color:#888;font-size:11px;margin-left:8px">Agent: ${l.agent_id || '—'}</span>
        </div>
      </div>
    `).join('');
  } catch(e) {
    grid.innerHTML = `<div class="empty-state">❌ ${e.message}</div>`;
  }
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
        return `
          <div class="employee-card">
            <div class="employee-info">
              <h4>${listing.title || 'AI员工'} ${isActive ? '<span class="status-badge status-active">工作中</span>' : '<span class="status-badge status-terminated">已解雇</span>'}</h4>
              <p>🪙 ${h.credits_paid || 0} 积分 | ${listing.category || '通用'} | 雇佣于 ${new Date(h.created_at).toLocaleDateString()}</p>
            </div>
            <div class="employee-actions">
              ${isActive ? `<a href="/?chat=${h.chat_id}" class="chat-btn" target="_blank">💬 工作群</a>` : ''}
              ${isActive ? `<button class="fire-btn" onclick="fireEmployee('${h.id}')">解雇</button>` : ''}
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
              <p>🪙 ${h.credits_paid || 0} 积分 | 雇佣者ID: ${h.buyer_id}</p>
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
