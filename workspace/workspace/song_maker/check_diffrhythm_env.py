# -*- coding: utf-8 -*-
"""检查 DiffRhythm 依赖环境"""
import sys
import importlib.util

print(f"Python: {sys.version}")
print(f"可执行: {sys.executable}")
print()

# DiffRhythm requirements 检查
reqs = [
    'accelerate', 'torchdiffeq', 'torchaudio', 'x_transformers',
    'transformers', 'librosa', 'pyarrow', 'pandas', 'pylance',
    'ema_pytorch', 'prefigure', 'bitsandbytes', 'muq', 'mutagen',
    'pykakasi', 'jieba', 'cn2an', 'pypinyin', 'onnxruntime',
    'Unidecode', 'phonemizer', 'inflect', 'py3langid',
]

print("=== DiffRhythm requirements 检查 ===")
for pkg in reqs:
    spec = importlib.util.find_spec(pkg)
    status = 'OK ' if spec else 'MISS'
    print(f"  [{status}] {pkg}")

print()
print("=== espeak-ng 检查 ===")
import shutil
espeak = shutil.which('espeak-ng') or shutil.which('espeak')
print(f"  espeak 可执行文件: {espeak}")

import os
for env_var in ['PHONEMIZER_ESPEAK_LIBRARY', 'PHONEMIZER_ESPEAK_PATH']:
    print(f"  {env_var} = {os.environ.get(env_var, '未设置')}")

# 检查常见安装位置
for p in [r'C:\Program Files\eSpeak NG', r'C:\Program Files (x86)\eSpeak NG']:
    if os.path.exists(p):
        print(f"  [OK] 找到安装目录: {p}")
        for f in os.listdir(p):
            print(f"       {f}")
    else:
        print(f"  [--] 不存在: {p}")

print()
print("=== torch 版本 ===")
try:
    import torch
    print(f"  torch: {torch.__version__}")
    print(f"  cuda: {torch.cuda.is_available()}")
except Exception as e:
    print(f"  torch 异常: {e}")
