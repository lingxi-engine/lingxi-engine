# -*- coding: utf-8 -*-
"""Step 1: 只加载模型，不做推理"""
import os, sys, time

os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join(os.getcwd(), "infer"))
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Device: {device}")
audio_length = 95
max_frames = 2048

print("Loading models...")
t0 = time.time()

from infer_utils import prepare_model
cfm, tokenizer, muq, vae = prepare_model(max_frames, device)

print(f"Models loaded in {time.time()-t0:.1f}s")
if device == "cuda":
    print(f"VRAM allocated: {torch.cuda.memory_allocated()/1024**3:.1f} GB")
print("ALL MODELS LOADED OK")