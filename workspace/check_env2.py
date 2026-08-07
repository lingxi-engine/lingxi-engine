import importlib, sys, os
print("Python:", sys.version)
mods = ["torch", "torchaudio", "torchdiffeq", "transformers", "x_transformers", "librosa",
        "pyarrow", "pandas", "pylance", "ema_pytorch", "prefigure", "bitsandbytes",
        "muq", "mutagen", "pykakasi", "jieba", "cn2an", "pypinyin", "onnxruntime",
        "Unidecode", "phonemizer", "inflect", "py3langid", "accelerate"]
for m in mods:
    try:
        mod = importlib.import_module(m)
        ver = getattr(mod, "__version__", "?")
        print(f"OK   {m} {ver}")
    except Exception as e:
        print(f"FAIL {m}: {type(e).__name__}: {e}")

if importlib.util.find_spec("torch"):
    import torch
    print("CUDA available:", torch.cuda.is_available())
    print("CUDA device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "N/A")

# espeak-ng check
import shutil
p = shutil.which("espeak-ng") or shutil.which("espeak")
print("espeak found at:", p)
