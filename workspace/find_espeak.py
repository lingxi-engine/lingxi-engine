# -*- coding: utf-8 -*-
import os, glob

# 1. espeak-ng 安装位置
candidates = [
    r"C:\Program Files\eSpeak NG",
    r"C:\Program Files (x86)\eSpeak NG",
    os.path.expanduser(r"~\AppData\Local\eSpeak NG"),
]
for c in candidates:
    if os.path.exists(c):
        print(f"[DIR] {c}")
        for f in os.listdir(c)[:30]:
            print("   ", f)

# 2. 在 PATH 中找 espeak
import shutil
print("which espeak-ng:", shutil.which("espeak-ng"))
print("which espeak:", shutil.which("espeak"))

# 3. 环境变量
for k in ("PHONEMIZER_ESPEAK_LIBRARY", "PHONEMIZER_ESPEAK_PATH"):
    print(f"ENV {k} = {os.environ.get(k)}")

# 4. 全盘快速找 libespeak-ng.dll（限常见目录）
print("\n--- search libespeak-ng.dll ---")
for root in [r"C:\Program Files", r"C:\Program Files (x86)", os.path.expanduser(r"~\AppData\Local")]:
    if not os.path.exists(root):
        continue
    for r, d, fs in os.walk(root):
        if len(r) > 60:
            d[:] = []
        for f in fs:
            if "espeak" in f.lower():
                print(os.path.join(r, f))
        if sum(len(x) for x in d) > 200:
            d[:] = []
