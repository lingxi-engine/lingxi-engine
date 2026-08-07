# -*- coding: utf-8 -*-
"""通过镜像加速下载 espeak-ng MSI"""
import os
import subprocess
import sys
import urllib.request

# espeak-ng 1.52.0 release 的 msi 资产名是 espeak-ng.msi
URLS = [
    # 各种 GitHub 加速镜像
    'https://mirror.ghproxy.com/https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi',
    'https://ghfast.top/https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi',
    'https://gh-proxy.com/https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi',
    'https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi',
]

def download(url, dest, timeout=120):
    print(f'尝试: {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, 'wb') as f:
        total = int(resp.headers.get('Content-Length', 0))
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                sys.stdout.write(f'\r  {pct}% ({done//1024//1024}/{total//1024//1024}MB)')
                sys.stdout.flush()
    print()
    return True

def main():
    dest = os.path.join(os.environ.get('TEMP', '.'), 'espeak-ng.msi')
    
    ok = False
    for url in URLS:
        try:
            if download(url, dest):
                ok = True
                break
        except Exception as e:
            print(f'  失败: {type(e).__name__}: {e}')
            # 清理不完整的文件
            if os.path.exists(dest):
                os.remove(dest)
    
    if not ok:
        print('所有镜像均失败')
        sys.exit(1)
    
    size_mb = os.path.getsize(dest) / 1024 / 1024
    print(f'下载完成: {size_mb:.1f}MB')
    
    # 静默安装
    print('静默安装 msiexec...')
    r = subprocess.run(['msiexec', '/i', dest, '/qn', '/norestart'],
                       capture_output=True, text=True, timeout=300)
    print(f'msiexec 退出码: {r.returncode}')
    
    # 验证
    for p in [r'C:\Program Files\eSpeak NG\espeak-ng.exe',
              r'C:\Program Files\eSpeak NG\libespeak-ng.dll']:
        print(f'  {"[OK] " if os.path.exists(p) else "[--] "}{p}')
    
    print('完成')

if __name__ == '__main__':
    main()
