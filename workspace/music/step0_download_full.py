# -*- coding: utf-8 -*-
"""Step 0: 尝试补全 DiffRhythm-1_2-full 模型下载"""
import os, sys, time

os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

print("Attempting to complete DiffRhythm-1_2-full download...")
t0 = time.time()

from huggingface_hub import hf_hub_download

try:
    path = hf_hub_download(
        repo_id="ASLP-lab/DiffRhythm-1_2-full",
        filename="cfm_model.pt",
        cache_dir="./pretrained",
    )
    print(f"Download complete! Path: {path}")
    print(f"Size: {os.path.getsize(path) / 1024**3:.2f} GB")
    print(f"Time: {time.time()-t0:.1f}s")
    print("SUCCESS")
except Exception as e:
    print(f"Download failed: {e}")
    print(f"Time: {time.time()-t0:.1f}s")
    
    # 检查 incomplete 文件大小
    import glob
    incomplete = glob.glob("./pretrained/models--ASLP-lab--DiffRhythm-1_2-full/blobs/*.incomplete")
    for f in incomplete:
        sz = os.path.getsize(f)
        print(f"Incomplete file: {f} ({sz / 1024**3:.3f} GB)")
    
    print("Will try using base model with 95s duration instead")
    print("FALLBACK_NEEDED")