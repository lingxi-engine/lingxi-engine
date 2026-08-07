# -*- coding: utf-8 -*-
"""安装 DiffRhythm 剩余依赖 + 设置 espeak 环境变量"""
import subprocess, sys, os

os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = r"C:\Program Files\eSpeak NG\libespeak-ng.dll"
os.environ["PATH"] = r"C:\Program Files\eSpeak NG" + os.pathsep + os.environ.get("PATH", "")

pkgs = [
    "muq==0.1.0",
    "torchdiffeq==0.2.5",
    "x-transformers==2.1.2",
    "ema-pytorch==0.7.7",
    "prefigure==0.0.10",
    "pykakasi==2.3.0",
    "cn2an==0.5.23",
    "pypinyin==0.53.0",
    "inflect==7.5.0",
    "py3langid",
    "mutagen==1.47.0",
    "jieba==0.42.1",
    "pandas==2.2.3",
    "einops",
]

for pkg in pkgs:
    print(f"\n=== pip install {pkg} ===")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", pkg,
         "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"],
        capture_output=True, text=True, timeout=600
    )
    tail = (r.stdout + r.stderr).strip().splitlines()
    print("\n".join(tail[-5:]))
    if r.returncode != 0:
        print(f"!! {pkg} 失败 rc={r.returncode}")

print("\n=== 全部完成 ===")
