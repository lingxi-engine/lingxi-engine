# -*- coding: utf-8 -*-
"""下载并安装 espeak-ng (Windows)"""
import json
import os
import subprocess
import sys
import urllib.request

def get_latest_release():
    """查询 espeak-ng 最新 release"""
    req = urllib.request.Request(
        'https://api.github.com/repos/espeak-ng/espeak-ng/releases/latest',
        headers={'User-Agent': 'Mozilla/5.0'}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))

def download(url, dest):
    """下载文件"""
    print(f'下载: {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, 'wb') as f:
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
                sys.stdout.write(f'\r  {pct}% ({done//1024//1024}MB / {total//1024//1024}MB)')
                sys.stdout.flush()
    print()
    return dest

def main():
    print('=== espeak-ng 安装 ===')
    
    # 1. 获取最新版本
    try:
        release = get_latest_release()
        tag = release['tag_name']
        print(f'最新版本: {tag}')
    except Exception as e:
        print(f'查询 release 失败: {e}')
        tag = '1.52.0'
        print(f'使用默认版本: {tag}')
    
    # 2. 找 msi 资产
    assets = release.get('assets', []) if 'release' in locals() else []
    msi_url = None
    for a in assets:
        name = a['name']
        if name.endswith('.msi') and 'x64' in name:
            msi_url = a['browser_download_url']
            print(f'找到 MSI: {name}')
            break
    if not msi_url:
        # 退而求其次：任何 msi
        for a in assets:
            if a['name'].endswith('.msi'):
                msi_url = a['browser_download_url']
                print(f'找到 MSI: {a["name"]}')
                break
    if not msi_url:
        # 构造常规 URL 尝试
        msi_url = f'https://github.com/espeak-ng/espeak-ng/releases/download/{tag}/espeak-ng-{tag}-setup-x64.msi'
        print(f'构造 URL: {msi_url}')
    
    # 3. 下载
    dest = os.path.join(os.environ.get('TEMP', '.'), 'espeak-ng-setup.msi')
    try:
        download(msi_url, dest)
    except Exception as e:
        print(f'下载失败: {e}')
        # 尝试备用 URL
        alt = f'https://github.com/espeak-ng/espeak-ng/releases/download/{tag}/espeak-ng-setup.msi'
        print(f'尝试备用: {alt}')
        download(alt, dest)
    
    size_mb = os.path.getsize(dest) / 1024 / 1024
    print(f'已下载: {dest} ({size_mb:.1f}MB)')
    
    # 4. 静默安装
    print('静默安装中...')
    result = subprocess.run(
        ['msiexec', '/i', dest, '/qn', '/norestart'],
        capture_output=True, text=True, timeout=300
    )
    print(f'msiexec 退出码: {result.returncode}')
    
    # 5. 验证
    for p in [r'C:\Program Files\eSpeak NG\espeak-ng.exe',
              r'C:\Program Files\eSpeak NG\libespeak-ng.dll']:
        print(f'  {"[OK] " if os.path.exists(p) else "[--] "}{p}')
    
    print('完成')

if __name__ == '__main__':
    main()
