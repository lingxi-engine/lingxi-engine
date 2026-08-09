# -*- coding: utf-8 -*-
"""检查 DiffRhythm 模型权重完整性"""
import os

base = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained'
print("=== pretrained 目录 ===")
for root, dirs, files in os.walk(base):
    level = root.replace(base, '').count(os.sep)
    indent = '  ' * level
    print(f"{indent}{os.path.basename(root)}/")
    for f in sorted(files):
        fp = os.path.join(root, f)
        sz = os.path.getsize(fp)
        print(f"{indent}  {f}  ({sz/1024/1024:.1f} MB)")
    # 只走一层
    if level >= 2:
        dirs[:] = []
