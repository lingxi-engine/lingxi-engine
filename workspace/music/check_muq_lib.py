# -*- coding: utf-8 -*-
"""检查 muq 库可用性"""
import importlib, sys, os
print("Python:", sys.version)
for m in ["muq", "transformers", "torch", "torchaudio", "librosa", "einops", "mutagen"]:
    try:
        mod = importlib.import_module(m)
        print("OK", m, getattr(mod, "__version__", "?"))
    except Exception as e:
        print("MISS", m, repr(e)[:120])

# 检查 muq 源码位置
import subprocess
r = subprocess.run([sys.executable, "-c", "import muq, os; print(os.path.dirname(muq.__file__))"],
                   capture_output=True, text=True)
print("muq path:", r.stdout.strip(), r.stderr.strip()[:200])
