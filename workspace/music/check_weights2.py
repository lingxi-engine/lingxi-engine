# -*- coding: utf-8 -*-
"""检查 DiffRhythm 主模型权重"""
import os

for d in [r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models\ASLP-lab--DiffRhythm-1_2',
          r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models\ASLP-lab--DiffRhythm-vae',
          r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained\models--ASLP-lab--DiffRhythm-vae']:
    print("=== ", d)
    if not os.path.isdir(d):
        print("  不存在")
        continue
    for root, dirs, files in os.walk(d):
        for f in sorted(files):
            fp = os.path.join(root, f)
            sz = os.path.getsize(fp)
            tag = ""
            if f.endswith(".incomplete"):
                tag = "  <-- 不完整!"
            print("  ", os.path.relpath(fp, d), f"({sz/1024/1024:.1f} MB){tag}")
