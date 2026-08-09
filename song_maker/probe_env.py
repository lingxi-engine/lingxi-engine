# -*- coding: utf-8 -*-
"""探测 Python 环境与音频相关依赖"""
import sys, platform, importlib

print("Python:", sys.version.split()[0])
print("Platform:", platform.platform())

mods = ["numpy", "scipy", "soundfile", "wave", "struct", "math", "os", "time"]
for m in mods:
    try:
        mod = importlib.import_module(m)
        ver = getattr(mod, "__version__", "?")
        print(f"  [OK] {m} {ver}")
    except Exception as e:
        print(f"  [FAIL] {m}: {e}")

# 检查 ffmpeg
import shutil
ff = shutil.which("ffmpeg")
print("ffmpeg:", ff if ff else "NOT FOUND")
