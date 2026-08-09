# -*- coding: utf-8 -*-
"""将 midnight_tape.wav 编码为 MP3"""
import numpy as np
import soundfile as sf
import lameenc

wav_path = r"C:\Users\Administrator\lingxi-engine\workspace\music\midnight_tape.wav"
mp3_path = r"C:\Users\Administrator\lingxi-engine\workspace\music\midnight_tape.mp3"

audio, sr = sf.read(wav_path)
print(f"WAV: {len(audio)} samples, {sr}Hz, shape={audio.shape}")

# lameenc 需要 int16
if audio.dtype != np.int16:
    audio_int = (audio * 32767).astype(np.int16)
else:
    audio_int = audio

# 确保是 2D (n, 2)
if len(audio_int.shape) == 1:
    audio_int = np.stack([audio_int, audio_int], axis=1)

encoder = lameenc.Encoder()
encoder.set_bit_rate(192)
encoder.set_in_sample_rate(sr)
encoder.set_channels(2)
encoder.set_quality(2)

mp3_data = encoder.encode(audio_int.tobytes())
mp3_data += encoder.flush()

with open(mp3_path, 'wb') as f:
    f.write(mp3_data)

import os
print(f"MP3 已输出: {mp3_path}")
print(f"MP3 大小: {os.path.getsize(mp3_path) / 1024 / 1024:.2f} MB")
print(f"时长: {len(audio) / sr:.1f} 秒")