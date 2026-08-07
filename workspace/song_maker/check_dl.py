# -*- coding: utf-8 -*-
"""检查下载结果 + 查找 muq 包"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

base = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
print("=== pretrained 下所有大文件 ===")
for root, dirs, files in os.walk(base):
    for f in files:
        fp = os.path.join(root, f)
        try:
            size = os.path.getsize(fp)
        except OSError:
            size = 0
        if size > 1024*1024:
            print(f"{size/1024/1024:8.1f} MB  {fp}")

print("\n=== 查找 muq 模块 ===")
for root, dirs, files in os.walk(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local"):
    for f in files:
        if 'muq' in f.lower() or 'mulan' in f.lower():
            print(os.path.join(root, f))

print("\n=== thirdparty 目录 ===")
tp = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\thirdparty"
if os.path.exists(tp):
    for item in os.listdir(tp):
        print(item)
