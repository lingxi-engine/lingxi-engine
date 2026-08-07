# -*- coding: utf-8 -*-
"""盘点 diffrhythm-local 已下载的模型权重文件"""
import os

base = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
print("=== pretrained 目录内容 ===")
for root, dirs, files in os.walk(base):
    for f in files:
        fp = os.path.join(root, f)
        try:
            size = os.path.getsize(fp)
        except OSError:
            size = -1
        if size > 1000:
            print(f"{size/1024/1024:.1f} MB  {fp}")
    for d in dirs:
        if d == ".locks":
            continue
        # 打印目录结构
print("\n=== 顶层结构 ===")
for item in os.listdir(base):
    p = os.path.join(base, item)
    if os.path.isdir(p):
        print(f"[DIR] {item}")
    else:
        print(f"[FILE] {item} ({os.path.getsize(p)} bytes)")
