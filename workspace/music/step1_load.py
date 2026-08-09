# -*- coding: utf-8 -*-
"""Step 1: 只加载模型，验证能成功"""
import os, sys, time
os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join(os.getcwd(), "infer"))
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
print(f"Device: {'cuda' if torch.cuda.is_available() else 'cpu'}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

max_frames = 6144
device = "cuda"

print("\nLoading models...")
t0 = time.time()

from infer_utils import prepare_model
cfm, tokenizer, muq, vae = prepare_model(max_frames, device)
print(f"All models loaded in {time.time()-t0:.1f}s")
print(f"CFM type: {type(cfm)}")
print(f"MuQ type: {type(muq)}")
print(f"VAE type: {type(vae)}")
print("SUCCESS - models ready")