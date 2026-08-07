# -*- coding: utf-8 -*-
"""从 ModelScope 下载 DiffRhythm 权重"""
import sys, os, time, json, urllib.request
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

def api(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    resp = urllib.request.urlopen(req, timeout=20)
    return json.loads(resp.read().decode('utf-8'))

# 列出 ModelScope 上 DiffRhythm-vae 的文件
for model_id in ["ASLP-lab/DiffRhythm-vae", "ASLP-lab/DiffRhythm-1_2"]:
    print(f"\n===== {model_id} 文件列表 =====")
    try:
        data = api(f"https://modelscope.cn/api/v1/models/{model_id}/repo/files?Revision=master&Recursive=true")
        files = data.get('Data', {}).get('Files', [])
        for f in files:
            p = f.get('Path', '')
            size = f.get('Size', 0)
            if size > 1024*1024:
                print(f"  {size/1024/1024:8.1f} MB  {p}")
    except Exception as e:
        print(f"  ERR: {str(e)[:120]}")
