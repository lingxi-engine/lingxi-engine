# -*- coding: utf-8 -*-
"""检查 MuQ 模型 + espeak 路径 + 推理脚本"""
import os, sys, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = r"C:\Users\Administrator\lingxi-engine"
DL = os.path.join(BASE, "diffrhythm-local")

print("=== 1. pretrained/models 下所有模型 ===")
pm = os.path.join(DL, "pretrained", "models")
if os.path.isdir(pm):
    for root, dirs, files in os.walk(pm):
        for f in files:
            fp = os.path.join(root, f)
            print(f"  {os.path.getsize(fp)/1024/1024:8.1f}MB  {fp}")
else:
    print("  无", pm)

print("\n=== 2. 找 MuQ / MuLan 相关 ===")
for root, dirs, files in os.walk(DL):
    dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
    for f in files:
        if 'muq' in f.lower() or 'mulan' in f.lower() or f == 'pytorch_model.bin':
            fp = os.path.join(root, f)
            print(f"  {os.path.getsize(fp)/1024/1024:8.1f}MB  {fp}")

print("\n=== 3. espeak 检查 ===")
for p in [r"C:\Program Files\eSpeak NG\espeak-ng.exe",
          r"C:\Program Files\eSpeak NG\libespeak-ng.dll",
          r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe"]:
    print(f"  {'OK ' if os.path.exists(p) else 'MISS'} {p}")

print("  PHONEMIZER_ESPEAK_LIBRARY =", os.environ.get("PHONEMIZER_ESPEAK_LIBRARY"))
print("  PATH contains espeak:", [p for p in os.environ.get("PATH","").split(os.pathsep) if 'espeak' in p.lower()])

print("\n=== 4. infer 脚本内容 ===")
infer = os.path.join(DL, "infer", "infer.py")
if os.path.exists(infer):
    with open(infer, encoding='utf-8', errors='replace') as f:
        content = f.read()
    print(content[:3000])
    print("...")
    print(f"[总长度 {len(content)} 字符]")
else:
    print("  无 infer.py")

print("\n=== 5. requirements.txt ===")
with open(os.path.join(DL, "requirements.txt"), encoding='utf-8') as f:
    print(f.read())
