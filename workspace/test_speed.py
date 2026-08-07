# -*- coding: utf-8 -*-
"""测试多个下载源的速度"""
import urllib.request, time, sys

def test(url, seconds=8):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Range": "bytes=0-1048575"})
    t0 = time.time()
    got = 0
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            while time.time() - t0 < seconds:
                chunk = resp.read(65536)
                if not chunk:
                    break
                got += len(chunk)
        speed = got / 1024 / 1024 / (time.time() - t0)
        print(f"[OK] {speed:.2f} MB/s ({got/1024:.0f}KB) {url[:90]}", flush=True)
        return speed
    except Exception as e:
        print(f"[FAIL] {type(e).__name__}: {e} | {url[:90]}", flush=True)
        return 0

FILE = "ASLP-lab/DiffRhythm-vae/resolve/main/vae_model.pt"

print("=== 测速 ===")
s1 = test(f"https://hf-mirror.com/{FILE}")
s2 = test(f"https://huggingface.co/{FILE}")
s3 = test(f"https://cdn-lfs.hf.co/{FILE}")
s4 = test(f"https://hf-mirror.com/{FILE.replace('resolve/main/', 'resolve/main/')}", 6)

# 检查 aria2c
import shutil
print("\naria2c:", shutil.which("aria2c"))
print("curl:", shutil.which("curl"))
