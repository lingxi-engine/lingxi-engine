# -*- coding: utf-8 -*-
"""将 xiangzheguang_raw.wav 编码为 MP3 (192kbps)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import soundfile as sf
import lameenc

SR = 44100
wav_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'xiangzheguang_raw.wav')
mp3_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'xiangzheguang.mp3')

print("读取 WAV...")
data, sr = sf.read(wav_path)
print("形状:", data.shape, "采样率:", sr)

# float -> 16-bit PCM 交错
pcm = np.clip(data, -1.0, 1.0)
pcm = (pcm * 32767.0).astype(np.int16)

enc = lameenc.Encoder()
enc.set_bit_rate(192)
enc.set_in_sample_rate(sr)
enc.set_channels(2)
enc.set_quality(2)  # 高质量

print("编码 MP3 (192kbps)...")
mp3_data = enc.encode(pcm.tobytes())
mp3_data += enc.flush()

with open(mp3_path, 'wb') as f:
    f.write(mp3_data)

print("已输出:", mp3_path)
print("MP3 大小(KB): %.1f" % (os.path.getsize(mp3_path) / 1024))

# 验证
info = sf.info(mp3_path)
print("MP3 时长(秒): %.2f" % info.duration)
print("MP3 采样率:", info.samplerate, "声道:", info.channels)
