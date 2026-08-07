# -*- coding: utf-8 -*-
"""探测 DiffRhythm 模型权重大小（走 hf-mirror）"""
import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
from huggingface_hub import HfApi

api = HfApi()
repos = [
    ("ASLP-lab/DiffRhythm-1_2", ["cfm_model.pt"]),
    ("ASLP-lab/DiffRhythm-vae", ["vae_model.pt"]),
    ("OpenMuQ/MuQ-MuLan-large", None),
]
for repo, files in repos:
    print(f"\n=== {repo} ===")
    try:
        infos = api.list_repo_files(repo)
        print("files:", infos[:20])
    except Exception as e:
        print(f"[ERR] {type(e).__name__}: {e}")
