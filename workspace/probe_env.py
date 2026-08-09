import sys
print("python:", sys.version)
mods = ["torch", "numpy", "scipy", "soundfile", "torchaudio", "transformers", "diffusers", "phonemizer", "espeakng", "librosa", "nltk", "safetensors", "pydub", "yaml", "einops"]
for m in mods:
    try:
        mod = __import__(m)
        v = getattr(mod, "__version__", "?")
        print(f"OK  {m} == {v}")
    except Exception as e:
        print(f"NO  {m}: {type(e).__name__}: {e}")

try:
    import torch
    print("cuda available:", torch.cuda.is_available())
    if torch.cuda.is_available():
        print("device:", torch.cuda.get_device_name(0))
        print("vram GB:", torch.cuda.get_device_properties(0).total_memory / 1e9)
except Exception as e:
    print("cuda check failed:", e)

import os
for k in ["PHONEMIZER_ESPEAK_LIBRARY", "PHONEMIZER_ESPEAK_PATH", "HF_HOME", "HUGGINGFACE_HUB_CACHE"]:
    print(f"env {k} =", os.environ.get(k))

# check espeak-ng install locations
for p in [r"C:\Program Files\eSpeak NG", r"C:\Program Files (x86)\eSpeak NG"]:
    print("exists", p, os.path.exists(p))

# check ffmpeg/lame in PATH
import shutil
for tool in ["ffmpeg", "ffprobe", "lame", "sox"]:
    print(f"tool {tool}:", shutil.which(tool))
