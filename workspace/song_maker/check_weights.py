# -*- coding: utf-8 -*-
"""全面盘点模型权重文件位置"""
import os, sys

# 用 UTF-8 输出避免乱码
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

targets = [
    r"C:\Users\Administrator\lingxi-engine\diffrhythm-local",
    r"C:\Users\Administrator\.cache\huggingface",
    r"C:\Users\Administrator\lingxi-engine\workspace",
]

print("=== 查找权重文件 (pt/bin/safetensors > 1MB) ===")
hits = []
for base in targets:
    if not os.path.exists(base):
        print(f"[MISS] {base}")
        continue
    for root, dirs, files in os.walk(base):
        # 跳过 .git 和 __pycache__
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__', 'node_modules')]
        for f in files:
            if f.endswith(('.pt', '.bin', '.safetensors', '.onnx')):
                fp = os.path.join(root, f)
                try:
                    size = os.path.getsize(fp)
                except OSError:
                    size = 0
                if size > 1024 * 1024:
                    hits.append((size, fp))

hits.sort(reverse=True)
for size, fp in hits:
    print(f"{size/1024/1024:8.1f} MB  {fp}")

if not hits:
    print("!! 没有任何已下载的权重文件")
