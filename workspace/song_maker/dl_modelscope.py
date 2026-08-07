# -*- coding: utf-8 -*-
"""从 ModelScope 下载 DiffRhythm 权重到本地"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

os.environ.setdefault("MODELSCOPE_CACHE", r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained")

from modelscope import snapshot_download

def download(model_id, files=None):
    print(f"=== 下载 {model_id} ===")
    path = snapshot_download(
        model_id,
        allow_patterns=files,
        cache_dir=r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained",
    )
    print(f"完成: {path}")
    return path

if __name__ == "__main__":
    # 先下载 VAE (595MB, 较快)
    download("ASLP-lab/DiffRhythm-vae", files=["vae_model.pt"])
    # 再下载 CFM (2.1GB)
    download("ASLP-lab/DiffRhythm-1_2", files=["cfm_model.pt"])
    print("\n=== 全部下载完成 ===")
