# -*- coding: utf-8 -*-
"""探测下载源速度和可用性"""
import sys, time, urllib.request, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

def probe(url, timeout=15, size=512*1024):
    """下载前 512KB 测速"""
    try:
        req = urllib.request.Request(url, headers={'Range': f'bytes=0-{size-1}', 'User-Agent': 'Mozilla/5.0'})
        t0 = time.time()
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = resp.read()
        dt = time.time() - t0
        speed = len(data) / dt / 1024 / 1024
        print(f"OK   {speed:6.1f} MB/s  {len(data)/1024:.0f} KB  {url[:110]}")
        return speed
    except Exception as e:
        print(f"FAIL {str(e)[:80]}  {url[:110]}")
        return 0

# 1. hf-mirror 具体文件测速
urls = [
    ("hf-mirror VAE", "https://hf-mirror.com/ASLP-lab/DiffRhythm-vae/resolve/main/vae_model.pt"),
    ("hf-mirror MuLan", "https://hf-mirror.com/OpenMuQ/MuQ-MuLan-large/resolve/main/pytorch_model.bin"),
    ("HF 官方 VAE", "https://huggingface.co/ASLP-lab/DiffRhythm-vae/resolve/main/vae_model.pt"),
]
for name, u in urls:
    print(f"[{name}]")
    probe(u)

# 2. ModelScope API 探测 ASLP-lab
print("\n[ModelScope 探测]")
try:
    req = urllib.request.Request("https://modelscope.cn/api/v1/models/ASLP-lab/DiffRhythm-vae", headers={'User-Agent': 'Mozilla/5.0'})
    resp = urllib.request.urlopen(req, timeout=15)
    data = json.loads(resp.read().decode('utf-8'))
    print("ModelScope ASLP-lab/DiffRhythm-vae 存在:", data.get('Code') == 200 or 'Data' in data)
except Exception as e:
    print(f"ModelScope VAE: {str(e)[:100]}")

try:
    req = urllib.request.Request("https://modelscope.cn/api/v1/models/ASLP-lab/DiffRhythm-1_2", headers={'User-Agent': 'Mozilla/5.0'})
    resp = urllib.request.urlopen(req, timeout=15)
    data = json.loads(resp.read().decode('utf-8'))
    print("ModelScope ASLP-lab/DiffRhythm-1_2 存在")
except Exception as e:
    print(f"ModelScope 1_2: {str(e)[:100]}")
