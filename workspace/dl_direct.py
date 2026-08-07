# -*- coding: utf-8 -*-
"""用 urllib 直接下载 hf-mirror 文件（绕过 xet 协议）"""
import os, sys, time, urllib.request

MIRROR = "https://hf-mirror.com"

def dl(repo, filename, dest_dir, timeout=60):
    url = f"{MIRROR}/{repo}/resolve/main/{filename}"
    dest = os.path.join(dest_dir, filename)
    os.makedirs(dest_dir, exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"[SKIP] {filename} 已存在 {os.path.getsize(dest)/1024/1024:.1f}MB", flush=True)
        return True
    tmp = dest + ".part"
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as f:
            total = int(resp.headers.get("Content-Length", 0))
            done = 0
            while True:
                chunk = resp.read(1024 * 512)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    sys.stdout.write(f"\r  {pct}% ({done//1024//1024}/{total//1024//1024}MB) {time.time()-t0:.0f}s")
                    sys.stdout.flush()
        print()
        os.replace(tmp, dest)
        print(f"[OK] {filename} {os.path.getsize(dest)/1024/1024:.1f}MB {time.time()-t0:.0f}s", flush=True)
        return True
    except Exception as e:
        print(f"\n[FAIL] {filename}: {type(e).__name__}: {e}", flush=True)
        if os.path.exists(tmp):
            os.remove(tmp)
        return False

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    dest = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
    ok = True
    if which in ("all", "vae"):
        ok &= dl("ASLP-lab/DiffRhythm-vae", "vae_model.pt", dest)
    if which in ("all", "muq"):
        ok &= dl("OpenMuQ/MuQ-MuLan-large", "pytorch_model.bin", dest)
        ok &= dl("OpenMuQ/MuQ-MuLan-large", "config.json", dest)
    if which in ("all", "cfm"):
        ok &= dl("ASLP-lab/DiffRhythm-1_2", "cfm_model.pt", dest)
        ok &= dl("ASLP-lab/DiffRhythm-1_2", "config.json", dest)
    print("\nRESULT:", "ALL OK" if ok else "PARTIAL")
