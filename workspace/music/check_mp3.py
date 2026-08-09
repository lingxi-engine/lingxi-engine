import importlib
for m in ["lameenc", "pydub", "audioread"]:
    try:
        mod = importlib.import_module(m)
        print("OK", m, getattr(mod, "__version__", "?"))
    except Exception as e:
        print("MISS", m, e)
import shutil
for exe in ["ffmpeg.exe", "lame.exe", "ffmpeg"]:
    p = shutil.which(exe)
    print(exe, "->", p)
