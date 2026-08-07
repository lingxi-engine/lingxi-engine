# -*- coding: utf-8 -*-
import os, sys, subprocess, glob

print("== CWD ==", os.getcwd())
for d in ["", "models", "weights", "diffrhythm", "DiffRhythm-1_2", "DiffRhythm-vae", "OpenMuQ"]:
    p = os.path.join(".", d)
    if os.path.isdir(p):
        try:
            items = os.listdir(p)
            print(f"\n[DIR] {p} ({len(items)} items)")
            for it in items[:30]:
                fp = os.path.join(p, it)
                if os.path.isfile(fp):
                    print(f"  FILE {it}  {os.path.getsize(fp)/1e6:.1f} MB")
                else:
                    print(f"  SUB  {it}/")
        except Exception as e:
            print(p, "ERR", e)

print("\n== tools ==")
for tool in ["aria2c", "curl", "wget", "git"]:
    try:
        r = subprocess.run([tool, "--version"], capture_output=True, text=True, timeout=10)
        print(tool, "OK ->", r.stdout.splitlines()[0] if r.stdout else r.stderr.splitlines()[0])
    except Exception as e:
        print(tool, "MISSING", type(e).__name__)

print("\n== sys ==")
print(sys.version)
try:
    import torch
    print("torch", torch.__version__, "cuda", torch.cuda.is_available())
except Exception as e:
    print("torch ERR", e)
