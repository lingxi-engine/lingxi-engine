# -*- coding: utf-8 -*-
"""设置 espeak 环境变量 + 下载 MuQ 权重"""
import os, sys, subprocess, time
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 1. 设置 espeak 环境变量（当前进程 + 持久化）
ESPEAK_DIR = r"C:\Program Files\eSpeak NG"
os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = os.path.join(ESPEAK_DIR, "libespeak-ng.dll")
os.environ["PATH"] = ESPEAK_DIR + os.pathsep + os.environ.get("PATH", "")

# 持久化
subprocess.run(["setx", "PHONEMIZER_ESPEAK_LIBRARY", os.path.join(ESPEAK_DIR, "libespeak-ng.dll")], capture_output=True)
subprocess.run(["setx", "PATH", ESPEAK_DIR + ";" + os.environ.get("PATH", "")[:1500]], capture_output=True)

# 2. 验证 espeak
try:
    from phonemizer.backend import EspeakBackend
    b = EspeakBackend("cmn")
    print("espeak OK, 支持语言数:", len(b.supported_languages()))
except Exception as e:
    print("espeak ERR:", e)

# 3. 设置 HF 镜像
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

# 4. 下载 MuQ 权重
from huggingface_hub import hf_hub_download
print("\n=== 下载 MuQ-MuLan-large ===")
t0 = time.time()
try:
    p = hf_hub_download(
        repo_id="OpenMuQ/MuQ-MuLan-large",
        filename="pytorch_model.bin",
        cache_dir=r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained",
    )
    print(f"MuQ 下载完成: {p}")
    print(f"大小: {os.path.getsize(p)/1024/1024:.1f} MB, 耗时 {time.time()-t0:.0f}s")
except Exception as e:
    print(f"MuQ 下载失败: {e}")
