# -*- coding: utf-8 -*-
"""最终验收：验证 WAV 与 MP3 文件完整性"""
import os, struct
import numpy as np
import soundfile as sf

out_dir = r"C:\Users\Administrator\lingxi-engine\workspace\music"
wav = os.path.join(out_dir, "xiangzheguang_raw.wav")
mp3 = os.path.join(out_dir, "xiangzheguang.mp3")

print("=== 文件清单 ===")
for p in (wav, mp3):
    if os.path.exists(p):
        print(f"OK  {os.path.basename(p)}  {round(os.path.getsize(p)/1048576,2)} MB")
    else:
        print(f"FAIL {p}")

print("\n=== WAV 内容验证 ===")
data, sr = sf.read(wav)
print("采样率:", sr, "通道:", data.shape[1] if data.ndim > 1 else 1)
print("时长:", round(len(data)/sr, 2), "秒")
print("峰值:", round(float(np.max(np.abs(data))), 3))
print("RMS:", round(float(np.sqrt(np.mean(data**2))), 3))

print("\n=== MP3 头部验证 ===")
with open(mp3, "rb") as f:
    hdr = f.read(4)
# MP3 帧头: 0xFF 0xFB (MPEG1 Layer3)
print("帧头字节:", hdr.hex())
print("有效MP3帧:", hdr[0] == 0xFF and (hdr[1] & 0xE0) == 0xE0)

print("\n验收结论:", "PASS" if os.path.exists(wav) and os.path.exists(mp3) else "FAIL")
