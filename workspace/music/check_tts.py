import subprocess, sys

results = {}

# 检查 pyttsx3
try:
    import pyttsx3
    results["pyttsx3"] = "OK"
except:
    results["pyttsx3"] = "MISSING"

# 检查 edge_tts
try:
    import edge_tts
    results["edge_tts"] = "OK"
except:
    results["edge_tts"] = "MISSING"

# 检查 soundfile + numpy（已知可用）
try:
    import soundfile, numpy
    results["soundfile"] = "OK"
except:
    results["soundfile"] = "MISSING"

# 检查 Windows SAPI
try:
    r = subprocess.run("where sapi", shell=True, capture_output=True, text=True)
    results["sapi"] = r.stdout.strip() if r.returncode == 0 else "MISSING"
except:
    results["sapi"] = "ERROR"

for k, v in results.items():
    print(f"{k}: {v}")
