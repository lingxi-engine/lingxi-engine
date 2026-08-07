# -*- coding: utf-8 -*-
"""安装 modelscope 并下载 DiffRhythm 全部权重"""
import sys, subprocess, os
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

print("=== 1. 安装 modelscope ===")
r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "modelscope", "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"], capture_output=True, text=True, timeout=300)
print("exit:", r.returncode)
if r.returncode != 0:
    print(r.stderr[-2000:])
else:
    print("安装成功")

print("\n=== 2. 探测 MuLan 在 ModelScope 上是否存在 ===")
import urllib.request, json
for mid in ["OpenMuQ/MuQ-MuLan-large", "ASLP-lab/MuQ-MuLan-large"]:
    try:
        req = urllib.request.Request(f"https://modelscope.cn/api/v1/models/{mid}/repo/files?Revision=master&Recursive=true", headers={'User-Agent': 'Mozilla/5.0'})
        data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode('utf-8'))
        files = data.get('Data', {}).get('Files', [])
        big = [f for f in files if f.get('Size', 0) > 1024*1024]
        print(f"{mid}: 存在, 大文件数={len(big)}")
        for f in big[:10]:
            print(f"   {f.get('Size',0)/1024/1024:.1f} MB  {f.get('Path')}")
    except Exception as e:
        print(f"{mid}: FAIL {str(e)[:100]}")
