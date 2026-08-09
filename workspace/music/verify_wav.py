# -*- coding: utf-8 -*-
"""验证 WAV 文件有效性和时长"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
try:
    import soundfile as sf
    print("soundfile OK")
except Exception as e:
    print("soundfile MISS:", e)
    sys.exit(1)

wav_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'xiangzheguang_raw.wav')
info = sf.info(wav_path)
print("文件:", wav_path)
print("大小(MB): %.1f" % (os.path.getsize(wav_path) / 1024 / 1024))
print("采样率:", info.samplerate)
print("声道数:", info.channels)
print("时长(秒): %.2f" % info.duration)
print("帧数:", info.frames)

# 检查音频内容非静音
data, sr = sf.read(wav_path)
print("峰值: %.4f" % np.max(np.abs(data)))
print("RMS: %.4f" % np.sqrt(np.mean(data ** 2)))
print("形状:", data.shape)
