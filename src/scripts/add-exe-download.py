with open('/var/www/lingxi/index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 简化的替换标记
old_marker = '复制</button>\n  </div>\n  <div class="install-box" style="margin-top:16px;border-color:#2a5a2a">'

download_html = '''  </div>
  <div class="install-box" style="margin-top:12px;border-color:#a855f7">
    <span class="os-tag win" style="background:#a855f7">Windows</span>
    <a href="/public/灵犀引擎.exe" style="color:#4ade80;text-decoration:none;font-size:14px;padding:12px 0;flex:1" download>&#x1F4E6; 下载 灵犀引擎.exe (72MB 便携版，开箱即用)</a>
    <a href="/public/灵犀引擎.exe" download><button style="background:#a855f7">下载</button></a>
  </div>
  <div class="install-box" style="margin-top:16px;border-color:#2a5a2a">'''

new_marker = download_html

if old_marker in html:
    html = html.replace(old_marker, new_marker, 1)
    with open('/var/www/lingxi/index.html', 'w', encoding='utf-8') as f:
        f.write(html)
    print('OK')
else:
    print('MARKER NOT FOUND')
    # debug
    idx = html.find('复制')
    print(repr(html[idx:idx+60]))
