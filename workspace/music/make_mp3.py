# -*- coding: utf-8 -*-
"""将渲染好的 WAV 编码为 MP3（使用 lameenc，纯本地）"""
import numpy as np
import soundfile as sf
import lameenc
import os

SR = 44100
out_dir = r"C:\Users\Administrator\lingxi-engine\workspace\music"
wav_path = os.path.join(out_dir, "xiangzheguang_raw.wav")
mp3_path = os.path.join(out_dir, "xiangzheguang.mp3")

data, sr = sf.read(wav_path, dtype="float32")
if sr != SR:
    raise RuntimeError(f"采样率不匹配: {sr}")

# float -> int16
pcm = (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)
# 交织立体声
interleaved = pcm.reshape(-1).tobytes()

encoder = lameenc.Encoder()
encoder.set_bit_rate(192)
encoder.set_in_sample_rate(SR)
encoder.set_channels(2)
encoder.set_quality(2)  # 高质量

mp3_data = encoder.encode(interleaved)
mp3_data += encoder.flush()

with open(mp3_path, "wb") as f:
    f.write(mp3_data)

print("MP3 OK:", mp3_path)
print("时长(秒):", len(data) / SR)
print("大小(MB):", round(os.path.getsize(mp3_path) / 1048576, 2))
