# -*- coding: utf-8 -*-
import shutil, os

src_dir = r"C:\Users\Administrator\lingxi-engine\workspace\music"
dst_dir = r"C:\Users\Administrator\Desktop"

files = ["daqiwancheng.wav", "daqiwancheng.mp3"]
for f in files:
    src = os.path.join(src_dir, f)
    dst = os.path.join(dst_dir, f)
    if os.path.exists(src):
        shutil.copy2(src, dst)
        sz = os.path.getsize(dst)
        print(f"OK  {f}  {sz:,} bytes -> {dst}")
    else:
        print(f"MISSING  {src}")