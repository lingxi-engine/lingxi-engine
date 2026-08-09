# -*- coding: utf-8 -*-
"""使用 hf-mirror 镜像下载 MuQ-MuLan-large 完整权重（断点续传）"""
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] = "120"

from huggingface_hub import snapshot_download

target = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
print("从 hf-mirror 下载 OpenMuQ/MuQ-MuLan-large ->", target)
try:
    p = snapshot_download(
        repo_id="OpenMuQ/MuQ-MuLan-large",
        cache_dir=target,
    )
    print("DONE:", p)
except Exception as e:
    import traceback
    traceback.print_exc()
    print("FAILED:", e)
