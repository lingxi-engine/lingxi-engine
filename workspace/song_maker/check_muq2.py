# -*- coding: utf-8 -*-
"""检查 MuQ 下载缓存状态 + 探测直链速度"""
import os, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
for root, dirs, files in os.walk(BASE):
    for f in files:
        fp = os.path.join(root, f)
        sz = os.path.getsize(fp)
        if 'muq' in fp.lower() or 'mulan' in fp.lower() or 'blobs' in fp.lower() or sz < 100:
            print(f"{sz/1024/1024:8.1f}MB  {fp}")

print("\n=== 探测 hf-mirror 直链 ===")
import urllib.request
url = "https://hf-mirror.com/OpenMuQ/MuQ-MuLan-large/resolve/main/pytorch_model.bin"
req = urllib.request.Request(url, method="HEAD")
try:
    resp = urllib.request.urlopen(req, timeout=30)
    print("HTTP", resp.status)
    print("Content-Length:", resp.headers.get("Content-Length"))
    print("Content-Type:", resp.headers.get("Content-Type"))
except Exception as e:
    print("HEAD ERR:", e)
