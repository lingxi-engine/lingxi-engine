# -*- coding: utf-8 -*-
"""下载 DiffRhythm 模型权重到 diffrhythm-local/pretrained"""
import os, sys, time
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"

CACHE = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
os.makedirs(CACHE, exist_ok=True)

from huggingface_hub import hf_hub_download

def dl(repo, filename, sub=None):
    t0 = time.time()
    print(f"\n>>> {repo}/{filename}", flush=True)
    path = hf_hub_download(
        repo_id=repo, filename=filename, cache_dir=CACHE, local_dir_use_symlinks=False
    )
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"[OK] {size_mb:.1f}MB  {time.time()-t0:.0f}s  -> {path}", flush=True)
    return path

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "vae"):
        dl("ASLP-lab/DiffRhythm-vae", "vae_model.pt")
    if which in ("all", "muq"):
        dl("OpenMuQ/MuQ-MuLan-large", "pytorch_model.bin")
        dl("OpenMuQ/MuQ-MuLan-large", "config.json")
    if which in ("all", "cfm"):
        dl("ASLP-lab/DiffRhythm-1_2", "cfm_model.pt")
        dl("ASLP-lab/DiffRhythm-1_2", "config.json")
    print("\nDONE")
