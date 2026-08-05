# -*- coding: utf-8 -*-
import subprocess, sys, json, urllib.request, time, socket

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

def out(s):
    sys.stdout.write(s + "\n")
    sys.stdout.flush()

out("=== 1. 引擎进程 ===")
try:
    r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq node.exe"], capture_output=True, text=True, timeout=15)
    out(r.stdout[:2000])
except Exception as e:
    out(f"tasklist FAIL: {e}")

out("\n=== 2. 3456 端口占用 ===")
try:
    r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=15)
    for line in r.stdout.splitlines():
        if ":3456" in line:
            out(line.strip())
except Exception as e:
    out(f"netstat FAIL: {e}")

out("\n=== 3. 多次重试 /api/health（判断是否假死） ===")
for i in range(3):
    try:
        req = urllib.request.Request("http://127.0.0.1:3456/api/health", method="GET")
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        out(f"  尝试{i+1}: OK ({time.time()-t0:.1f}s) {body[:200]}")
    except Exception as e:
        out(f"  尝试{i+1}: FAIL {str(e)[:120]}")

out("\n=== 4. 引擎日志尾部（最近 30 行） ===")
try:
    with open(r"C:\Users\Administrator\lingxi-engine\data\logs\lingxi-2026-08-05.log", "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 6000))
        tail = f.read().decode("utf-8", errors="replace")
    lines = tail.splitlines()
    for line in lines[-30:]:
        out(line)
except Exception as e:
    out(f"log read FAIL: {e}")
