# -*- coding: utf-8 -*-
"""全面检查 DiffRhythm 环境状态"""
import os, sys, subprocess
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = r"C:\Users\Administrator\lingxi-engine"
CWD = os.path.join(BASE, "workspace", "song_maker")

print("=== 1. song_maker 目录 ===")
for it in sorted(os.listdir(CWD)):
    fp = os.path.join(CWD, it)
    if os.path.isfile(fp):
        print(f"  FILE {it} {os.path.getsize(fp)/1024:.0f}KB")
    else:
        print(f"  DIR  {it}/")

print("\n=== 2. diffrhythm 仓库 ===")
dr = os.path.join(CWD, "diffrhythm")
if os.path.isdir(dr):
    for it in sorted(os.listdir(dr))[:30]:
        print("  ", it)
    # 看有没有 python 文件
    py_files = [f for f in os.listdir(dr) if f.endswith(".py")]
    print("  py files:", py_files)
else:
    print("  不存在!")

print("\n=== 3. diffrhythm-local (权重目录) ===")
dl = os.path.join(BASE, "diffrhythm-local")
if os.path.isdir(dl):
    for root, dirs, files in os.walk(dl):
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
        for f in files:
            fp = os.path.join(root, f)
            sz = os.path.getsize(fp)
            if sz > 1024*1024:
                print(f"  {sz/1024/1024:8.1f}MB  {fp}")
            else:
                print(f"  {sz:8d}B  {fp}")
else:
    print("  不存在!")

print("\n=== 4. huggingface 缓存 ===")
hf = os.path.join(BASE, ".cache", "huggingface")
if os.path.isdir(hf):
    for root, dirs, files in os.walk(hf):
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
        depth = root[len(hf):].count(os.sep)
        if depth > 3:
            dirs[:] = []
            continue
        for f in files:
            fp = os.path.join(root, f)
            sz = os.path.getsize(fp)
            if sz > 1024*1024:
                print(f"  {sz/1024/1024:8.1f}MB  {fp}")
else:
    print("  不存在!")

print("\n=== 5. Python 包检查 ===")
for pkg in ["torch", "diffusers", "modelscope", "transformers", "phonemizer", "onnxruntime", "pyarrow", "soundfile", "librosa", "numpy"]:
    try:
        mod = __import__(pkg)
        ver = getattr(mod, "__version__", "?")
        print(f"  {pkg:15s} {ver}")
    except Exception as e:
        print(f"  {pkg:15s} MISSING ({e.__class__.__name__})")

print("\n=== 6. espeak ===")
try:
    from phonemizer.backend import EspeakBackend
    b = EspeakBackend("cmn")
    print("  EspeakBackend('cmn') OK, languages:", len(b.supported_languages()))
except Exception as e:
    print("  espeak ERR:", e)
