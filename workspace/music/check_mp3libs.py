# -*- coding: utf-8 -*-
mods = ["pydub", "lameenc", "audioread", "soundfile"]
import importlib
for m in mods:
    try:
        mod = importlib.import_module(m)
        print(m, "OK", getattr(mod, "__version__", ""))
    except Exception as e:
        print(m, "MISSING", type(e).__name__)
