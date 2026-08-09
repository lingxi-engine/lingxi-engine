# -*- coding: utf-8 -*-
"""测试 ModelScope 镜像与 MuQ 模型下载可用性"""
import urllib.request
import json

# 测试 ModelScope API 可访问性
urls = [
    ("ModelScope API", "https://modelscope.cn/api/v1/models/OpenMuQ/MuQ-MuLan-large"),
    ("ModelScope 模型页", "https://modelscope.cn/models/OpenMuQ/MuQ-MuLan-large"),
    ("hf-mirror", "https://hf-mirror.com/OpenMuQ/MuQ-MuLan-large/resolve/main/config.json"),
    ("HuggingFace", "https://huggingface.co/OpenMuQ/MuQ-MuLan-large/resolve/main/config.json"),
]

for name, url in urls:
    try:
        req = urllib.request.Request(url, method='HEAD')
        resp = urllib.request.urlopen(req, timeout=10)
        print(f"[OK] {name}: HTTP {resp.status}, 长度={resp.headers.get('Content-Length')}")
    except Exception as e:
        try:
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, timeout=10)
            data = resp.read(200)
            print(f"[OK] {name}: HTTP {resp.status}, 前200字节={data[:80]!r}")
        except Exception as e2:
            print(f"[FAIL] {name}: {e2}")
