# -*- coding: utf-8 -*-
import io

path = 'web/design-preview.html'
html = io.open(path, encoding='utf-8').read()

# ── 1. 新顶栏 Logo（方案A：信号核心 · 灵犀一点） ──
new_logo = '''<a class="logo" href="#" title="灵犀引擎 · LINGXI ENGINE">
    <svg class="logo-mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="v10A-core" cx=".34" cy=".28" r=".9">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset=".32" stop-color="color-mix(in srgb,var(--accent) 40%,#fff)"/>
          <stop offset=".72" stop-color="var(--accent)"/>
          <stop offset="1" stop-color="color-mix(in srgb,var(--accent2) 82%,#000)"/>
        </radialGradient>
        <radialGradient id="v10A-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="var(--accent)" stop-opacity=".5"/>
          <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <!-- 外发光 -->
      <circle cx="32" cy="30" r="27" fill="url(#v10A-glow)"/>
      <!-- 信号波纹环 x2（引擎脉冲） -->
      <circle cx="32" cy="30" r="23.5" fill="none" stroke="color-mix(in srgb,var(--accent) 40%,transparent)" stroke-width="1.6"/>
      <circle cx="32" cy="30" r="28.5" fill="none" stroke="color-mix(in srgb,var(--accent) 18%,transparent)" stroke-width="1.2"/>
      <!-- 地面投影（悬浮立体） -->
      <ellipse cx="32" cy="57" rx="16" ry="3.4" fill="#000" opacity=".32"/>
      <!-- 核心球体（径向渐变，光源左上） -->
      <circle cx="32" cy="30" r="16" fill="url(#v10A-core)"/>
      <!-- 顶部玻璃高光弧 -->
      <path d="M22 25 A14.5 14.5 0 0 1 38 19.5" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M24.5 28.5 A11.5 11.5 0 0 1 32.5 22.6" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3.4" stroke-linecap="round"/>
      <!-- 底部环境反光 -->
      <path d="M22.5 36.5 A12.5 12.5 0 0 0 41.5 36.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2" stroke-linecap="round"/>
      <!-- 中心亮点（灵犀一点） -->
      <circle cx="32" cy="31" r="3.2" fill="#fff" opacity=".9"/>
    </svg>
  <span class="logo-txt"><b>灵犀引擎</b><i>LINGXI&nbsp;ENGINE</i></span>
</a>'''

j0 = html.find('<a class="logo"')
j1 = html.find('</a>', j0) + 4
assert j0 > 0 and j1 > j0, 'logo 未找到'
html = html[:j0] + new_logo + html[j1:]

# ── 2. 方案对比展示区 ──
showcase = '''
<!-- ═══ Logo 方案对比（v10：四个方向任选）═══ -->
<div class="logo-showcase">
  <div class="show-head">🎨 <b>Logo 方案对比</b> —— 顶栏当前展示 A，四个方向任选一个，我继续细化</div>
  <div class="show-grid">

    <div class="show-card">
      <div class="show-preview">
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="v10A2-core" cx=".34" cy=".28" r=".9">
              <stop offset="0" stop-color="#ffffff"/>
              <stop offset=".32" stop-color="color-mix(in srgb,var(--accent) 40%,#fff)"/>
              <stop offset=".72" stop-color="var(--accent)"/>
              <stop offset="1" stop-color="color-mix(in srgb,var(--accent2) 82%,#000)"/>
            </radialGradient>
            <radialGradient id="v10A2-glow" cx=".5" cy=".5" r=".5">
              <stop offset="0" stop-color="var(--accent)" stop-opacity=".5"/>
              <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <circle cx="32" cy="30" r="27" fill="url(#v10A2-glow)"/>
          <circle cx="32" cy="30" r="23.5" fill="none" stroke="color-mix(in srgb,var(--accent) 40%,transparent)" stroke-width="1.6"/>
          <circle cx="32" cy="30" r="28.5" fill="none" stroke="color-mix(in srgb,var(--accent) 18%,transparent)" stroke-width="1.2"/>
          <ellipse cx="32" cy="57" rx="16" ry="3.4" fill="#000" opacity=".32"/>
          <circle cx="32" cy="30" r="16" fill="url(#v10A2-core)"/>
          <path d="M22 25 A14.5 14.5 0 0 1 38 19.5" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2.6" stroke-linecap="round"/>
          <path d="M24.5 28.5 A11.5 11.5 0 0 1 32.5 22.6" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3.4" stroke-linecap="round"/>
          <path d="M22.5 36.5 A12.5 12.5 0 0 0 41.5 36.5" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2" stroke-linecap="round"/>
          <circle cx="32" cy="31" r="3.2" fill="#fff" opacity=".9"/>
        </svg>
      </div>
      <div class="show-name">A · 信号核心</div>
      <div class="show-desc">发光球体 + 雷达脉冲环：引擎运转、向外感应，寓意「灵犀一点通」</div>
      <span class="show-tag">顶栏当前方案</span>
    </div>

    <div class="show-card">
      <div class="show-preview">
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="v10B-horn" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stop-color="color-mix(in srgb,var(--accent2) 88%,#000)"/>
              <stop offset=".45" stop-color="var(--accent)"/>
              <stop offset="1" stop-color="#ffffff"/>
            </linearGradient>
            <radialGradient id="v10B-tip" cx=".5" cy=".5" r=".5">
              <stop offset="0" stop-color="#fff"/>
              <stop offset=".6" stop-color="#fff" stop-opacity=".6"/>
              <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <ellipse cx="33" cy="56" rx="15" ry="3" fill="#000" opacity=".30"/>
          <path d="M20 50 C 12 36 16 20 40 10" fill="none" stroke="color-mix(in srgb,var(--accent2) 62%,#000)" stroke-width="11" stroke-linecap="round" transform="translate(3.2,3.2)"/>
          <path d="M20 50 C 12 36 16 20 40 10" fill="none" stroke="url(#v10B-horn)" stroke-width="10" stroke-linecap="round"/>
          <path d="M18.5 47.5 C 11 35 15 21 37.5 12" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>
          <circle cx="40" cy="10" r="7" fill="url(#v10B-tip)"/>
          <circle cx="40" cy="10" r="2.6" fill="#fff"/>
        </svg>
      </div>
      <div class="show-name">B · 能量犀角</div>
      <div class="show-desc">犀牛角 = 「犀」字本义：锋利、突破、力量；角尖发光，像引擎点火</div>
      <span class="show-tag">动物意象但抽象化</span>
    </div>

    <div class="show-card">
      <div class="show-preview">
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="v10C-l" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stop-color="var(--accent2)"/>
              <stop offset="1" stop-color="#ffffff"/>
            </linearGradient>
            <linearGradient id="v10C-r" x1="1" y1="1" x2="0" y2="0">
              <stop offset="0" stop-color="var(--accent2)"/>
              <stop offset="1" stop-color="#ffffff"/>
            </linearGradient>
            <radialGradient id="v10C-core" cx=".34" cy=".3" r=".9">
              <stop offset="0" stop-color="#ffffff"/>
              <stop offset=".45" stop-color="var(--accent)"/>
              <stop offset="1" stop-color="color-mix(in srgb,var(--accent2) 80%,#000)"/>
            </radialGradient>
          </defs>
          <ellipse cx="32" cy="57" rx="16" ry="3" fill="#000" opacity=".30"/>
          <path d="M16 46 A 17 17 0 0 1 16 18" fill="none" stroke="url(#v10C-l)" stroke-width="9" stroke-linecap="round"/>
          <path d="M48 18 A 17 17 0 0 1 48 46" fill="none" stroke="url(#v10C-r)" stroke-width="9" stroke-linecap="round"/>
          <circle cx="32" cy="32" r="11" fill="color-mix(in srgb,var(--accent) 26%,transparent)"/>
          <circle cx="32" cy="32" r="6" fill="url(#v10C-core)"/>
          <circle cx="29.8" cy="29.8" r="1.7" fill="#fff" opacity=".9"/>
        </svg>
      </div>
      <div class="show-name">C · 双弧感应</div>
      <div class="show-desc">两条相对弧线 + 中间光点：心有灵犀的两个端点互相感应、连接</div>
      <span class="show-tag">寓意最贴品牌</span>
    </div>

    <div class="show-card">
      <div class="show-preview">
        <div class="txt-only"><b>灵犀引擎</b><i>LINGXI&nbsp;ENGINE</i></div>
      </div>
      <div class="show-name">D · 纯文字排版</div>
      <div class="show-desc">完全不要图形：超大立体字 + 字距呼吸感，最干净也最不容易出错</div>
      <span class="show-tag">最克制</span>
    </div>

  </div>
</div>
'''

j2 = html.find('</nav>')
assert j2 > 0, 'nav 未找到'
html = html[:j2 + 6] + showcase + html[j2 + 6:]

# ── 3. showcase CSS ──
css = '''
/* ═══ v10 Logo 方案对比区 ═══ */
.logo-showcase{background:var(--bg);border-bottom:1px solid var(--border);padding:12px 16px 16px}
.show-head{font-size:12px;color:var(--text3);margin-bottom:10px;letter-spacing:.3px}
.show-head b{color:var(--accent)}
.show-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px}
.show-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 12px 12px;text-align:center;transition:transform .25s,border-color .25s,box-shadow .25s}
.show-card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--accent) 55%,transparent);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.show-preview{height:86px;display:flex;align-items:center;justify-content:center;margin-bottom:6px}
.show-preview svg{width:66px;height:66px;filter:drop-shadow(0 4px 6px rgba(0,0,0,.28))}
.show-name{font-weight:800;font-size:13.5px;color:var(--text);letter-spacing:.3px}
.show-desc{font-size:11px;color:var(--text3);margin-top:5px;line-height:1.55;min-height:32px}
.show-tag{display:inline-block;margin-top:7px;font-size:10px;padding:2px 9px;border-radius:20px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent)}
.txt-only b{font-size:32px;font-weight:900;letter-spacing:1px;background:linear-gradient(180deg,#fff 0%,color-mix(in srgb,var(--accent) 55%,#fff) 22%,var(--accent) 50%,color-mix(in srgb,var(--accent2) 85%,#000) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 1px 0 rgba(255,255,255,.5),0 2px 0 color-mix(in srgb,var(--accent2) 74%,#000),0 3px 0 color-mix(in srgb,var(--accent2) 60%,#000),0 4px 0 color-mix(in srgb,var(--accent2) 46%,#000),0 6px 12px rgba(0,0,0,.35)}
.txt-only i{display:block;font-style:normal;font-size:10px;letter-spacing:3px;color:var(--text3);font-family:var(--mono);margin-top:3px}
body.theme-mini .logo-showcase .show-card{background:transparent}
body.theme-mini .txt-only b{background:none;color:var(--accent);text-shadow:none}
'''
k = html.rfind('</style>')
assert k > 0, 'style 未找到'
html = html[:k] + css + html[k:]

# ── 4. note-bar 文案更新 ──
old_note = '<b>📐 设计稿 v9 — Logo 3D 切割晶体宝石（加大版）+ 积分/钱包拆分 + 6 套主题</b>'
new_note = '<b>📐 设计稿 v10 — Logo 四个新方向对比（信号核心/能量犀角/双弧感应/纯文字）+ 积分/钱包拆分 + 6 套主题</b>'
if old_note in html:
    html = html.replace(old_note, new_note)

io.open(path, 'w', encoding='utf-8', newline='').write(html)
print('OK done, len =', len(html))
