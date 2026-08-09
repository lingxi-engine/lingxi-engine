import importlib
mods = ["numpy", "scipy", "soundfile", "pydub", "midiutil", "mido", "torch", "torchaudio", "librosa", "audioread", "pydub"]
for m in mods:
    try:
        mod = importlib.import_module(m)
        v = getattr(mod, "__version__", "?")
        print(f"OK   {m} {v}")
    except Exception as e:
        print(f"MISS {m}: {type(e).__name__} {e}")
