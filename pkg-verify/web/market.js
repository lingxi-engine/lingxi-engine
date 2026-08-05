/**
 * market.js — AI员工市场
 * 功能：浏览、搜索、雇佣、委派AI员工
 */

// ========== 市场数据 ==========
let marketAgents = [];
let hireRequests = new Map();

const MARKET_API = '/api/agents';

// ========== 初始化 ==========
function initMarket() {
    console.log('[Market] 初始化...');
    loadMarketAgents();
}

// ========== 加载市场数据 ==========
async function loadMarketAgents() {
    try {
        const res = await fetch(MARKET_API);
        const data = await res.json();
        if (data.success) {
            marketAgents = data.data || [];
        } else {
            // 如果后端接口不可用，加载模拟数据
            marketAgents = getMockAgents();
        }
    } catch (e) {
        console.warn('[Market] 后端接口不可用，使用模拟数据');
        marketAgents = getMockAgents();
    }
    renderMarket();
}

// ========== 模拟数据 ==========
function getMockAgents() {
    return [
        { id: 'agent-1', name: '代码助手', avatar: '💻', description: '精通前后端开发，支持多种编程语言', skills: ['JavaScript', 'Python', 'React', 'Node.js'], price: 0, rating: 4.8, hired: 128 },
        { id: 'agent-2', name: '文案写手', avatar: '✍️', description: '专业的文案创作与编辑', skills: ['写作', '编辑', '翻译', '润色'], price: 0, rating: 4.6, hired: 95 },
        { id: 'agent-3', name: '数据分析师', avatar: '📊', description: '数据挖掘、分析与可视化', skills: ['SQL', 'Python', 'Excel', 'Tableau'], price: 0, rating: 4.7, hired: 73 },
        { id: 'agent-4', name: '设计助手', avatar: '🎨', description: 'UI/UX 设计与创意输出', skills: ['Figma', 'Photoshop', '色彩搭配', '排版'], price: 0, rating: 4.5, hired: 56 },
        { id: 'agent-5', name: '客服机器人', avatar: '🤖', description: '7x24小时智能客服', skills: ['多轮对话', '工单管理', '知识库', '情绪识别'], price: 0, rating: 4.4, hired: 201 },
        { id: 'agent-6', name: '研究助手', avatar: '🔬', description: '文献检索与学术研究辅助', skills: ['文献搜索', '摘要生成', '引用管理', '综述写作'], price: 0, rating: 4.9, hired: 42 },
    ];
}

// ========== 渲染市场 ==========
function renderMarket(filter = '') {
    const container = document.getElementById('marketContent');
    if (!container) return;

    let agents = marketAgents;
    if (filter) {
        const f = filter.toLowerCase();
        agents = agents.filter(a => 
            a.name.toLowerCase().includes(f) ||
            a.description.toLowerCase().includes(f) ||
            a.skills.some(s => s.toLowerCase().includes(f))
        );
    }

    if (agents.length === 0) {
        container.innerHTML = `
            <div class="market-empty">
                <div class="market-empty-icon">🔍</div>
                <div class="market-empty-text">没有找到匹配的AI员工</div>
            </div>
        `;
        return;
    }

    container.innerHTML = agents.map(agent => `
        <div class="market-card" data-agent-id="${agent.id}">
            <div class="market-card-header">
                <div class="market-card-avatar">${agent.avatar}</div>
                <div class="market-card-info">
                    <div class="market-card-name">${agent.name}</div>
                    <div class="market-card-rating">
                        ${'⭐'.repeat(Math.floor(agent.rating))}
                        <span class="market-rating-num">${agent.rating}</span>
                    </div>
                </div>
                <div class="market-card-hired">已雇佣 ${agent.hired} 次</div>
            </div>
            <div class="market-card-desc">${agent.description}</div>
            <div class="market-card-skills">
                ${agent.skills.map(s => `<span class="market-skill-tag">${s}</span>`).join('')}
            </div>
            <div class="market-card-actions">
                ${agent.price === 0 
                    ? `<button class="market-btn market-btn-primary" onclick="hireAgent('${agent.id}')">🤝 雇佣</button>`
                    : `<button class="market-btn market-btn-primary" onclick="hireAgent('${agent.id}')">💰 ${agent.price}灵犀币/月</button>`
                }
                <button class="market-btn market-btn-secondary" onclick="viewAgentDetail('${agent.id}')">👁️ 详情</button>
            </div>
        </div>
    `).join('');

    // 绑定事件
    container.querySelectorAll('.market-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const id = card.dataset.agentId;
            viewAgentDetail(id);
        });
    });
}

// ========== 雇佣流程 ==========
function hireAgent(agentId) {
    const agent = marketAgents.find(a => a.id === agentId);
    if (!agent) return;

    if (hireRequests.has(agentId)) {
        showToast('⏳ 已发起雇佣请求，请等待审批');
        return;
    }

    // 显示雇佣对话框
    showHireDialog(agent);
}

function showHireDialog(agent) {
    // 移除已存在的弹窗
    const oldDialog = document.querySelector('.market-dialog-overlay');
    if (oldDialog) oldDialog.remove();

    const overlay = document.createElement('div');
    overlay.className = 'market-dialog-overlay';
    overlay.innerHTML = `
        <div class="market-dialog">
            <div class="market-dialog-header">
                <span>🤝 雇佣 ${agent.name}</span>
                <button class="market-dialog-close" onclick="this.closest('.market-dialog-overlay').remove()">✕</button>
            </div>
            <div class="market-dialog-body">
                <div class="market-dialog-agent">
                    <span class="market-dialog-avatar">${agent.avatar}</span>
                    <div>
                        <div class="market-dialog-name">${agent.name}</div>
                        <div class="market-dialog-rating">${'⭐'.repeat(Math.floor(agent.rating))} ${agent.rating}</div>
                    </div>
                </div>
                <div class="market-form-group">
                    <label>委派任务描述</label>
                    <textarea class="market-input market-textarea" id="hireTaskDesc" placeholder="描述你希望AI员工做什么..." rows="3"></textarea>
                </div>
                <div class="market-form-group">
                    <label>权限范围</label>
                    <div class="market-checkbox-group">
                        <label class="market-checkbox">
                            <input type="checkbox" checked disabled> 💬 对话
                        </label>
                        <label class="market-checkbox">
                            <input type="checkbox" checked> 🔍 搜索
                        </label>
                        <label class="market-checkbox">
                            <input type="checkbox"> 📁 文件操作
                        </label>
                        <label class="market-checkbox">
                            <input type="checkbox"> 💻 代码执行
                        </label>
                    </div>
                </div>
            </div>
            <div class="market-dialog-footer">
                <button class="market-btn market-btn-secondary" onclick="this.closest('.market-dialog-overlay').remove()">取消</button>
                <button class="market-btn market-btn-primary" onclick="confirmHire('${agent.id}')">✅ 确认雇佣</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

async function confirmHire(agentId) {
    const agent = marketAgents.find(a => a.id === agentId);
    if (!agent) return;

    const taskDesc = document.getElementById('hireTaskDesc')?.value || '';
    const overlay = document.querySelector('.market-dialog-overlay');
    
    try {
        // 尝试调用后端API
        const res = await fetch('/api/agents/hire', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, task: taskDesc })
        });
        const data = await res.json();
        if (data.success) {
            hireRequests.set(agentId, { status: 'pending', time: Date.now() });
            showToast(`✅ 已发起雇佣请求「${agent.name}」，等待审批`);
            if (overlay) overlay.remove();
            return;
        }
    } catch (e) {
        // 后端不可用时模拟成功
    }

    // 模拟雇佣成功
    hireRequests.set(agentId, { status: 'approved', time: Date.now() });
    showToast(`🎉 ${agent.name} 已加入你的团队！`);
    
    // 通知主程序刷新员工列表
    if (window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('agent-hired', { detail: { agent } }));
    }
    
    if (overlay) overlay.remove();
}

// ========== 查看详情 ==========
function viewAgentDetail(agentId) {
    const agent = marketAgents.find(a => a.id === agentId);
    if (!agent) return;

    const container = document.getElementById('marketContent');
    if (!container) return;

    container.innerHTML = `
        <div class="market-detail">
            <button class="market-btn market-btn-back" onclick="renderMarket()">← 返回市场</button>
            <div class="market-detail-header">
                <div class="market-detail-avatar">${agent.avatar}</div>
                <div>
                    <div class="market-detail-name">${agent.name}</div>
                    <div class="market-detail-rating">${'⭐'.repeat(Math.floor(agent.rating))} ${agent.rating} · 已雇佣 ${agent.hired} 次</div>
                </div>
            </div>
            <div class="market-detail-section">
                <div class="market-detail-label">简介</div>
                <div class="market-detail-text">${agent.description}</div>
            </div>
            <div class="market-detail-section">
                <div class="market-detail-label">技能</div>
                <div class="market-card-skills">
                    ${agent.skills.map(s => `<span class="market-skill-tag">${s}</span>`).join('')}
                </div>
            </div>
            <div class="market-detail-section">
                <div class="market-detail-label">价格</div>
                <div class="market-detail-text">${agent.price === 0 ? '免费' : agent.price + ' 灵犀币/月'}</div>
            </div>
            <button class="market-btn market-btn-primary market-btn-large" onclick="hireAgent('${agent.id}')">🤝 雇佣 ${agent.name}</button>
        </div>
    `;
}

// ========== 搜索 ==========
function setupMarketSearch() {
    const searchInput = document.getElementById('marketSearch');
    if (!searchInput) return;

    let debounceTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            renderMarket(searchInput.value);
        }, 300);
    });
}

// ========== 导出 ==========
window.initMarket = initMarket;
window.renderMarket = renderMarket;
window.hireAgent = hireAgent;
window.viewAgentDetail = viewAgentDetail;
window.confirmHire = confirmHire;
window.setupMarketSearch = setupMarketSearch;
