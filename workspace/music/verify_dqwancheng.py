# -*- coding: utf-8 -*-
"""验证 daqiwancheng 成品"""
import os, struct, wave

base = os.path.dirname(os.path.abspath(__file__))

# 验证 WAV
wav_path = os.path.join(base, 'daqiwancheng.wav')
with wave.open(wav_path, 'rb') as w:
    ch = w.getnchannels()
    sr = w.getframerate()
    bw = w.getsampwidth()
    n = w.getnframes()
    dur = n / sr
    print(f"WAV: {ch}ch / {sr}Hz / {bw*8}bit / {dur:.1f}s / {os.path.getsize(wav_path):,} bytes")

# 验证 MP3
mp3_path = os.path.join(base, 'daqiwancheng.mp3')
mp3_size = os.path.getsize(mp3_path)
with open(mp3_path, 'rb') as f:
    header = f.read(10)
    if header[:3] == b'ID3':
        print(f"MP3: ID3v2 tag present, size={mp3_size:,} bytes ({mp3_size/1024/1024:.2f} MB)")
    else:
        print(f"MP3: no ID3 tag, size={mp3_size:,} bytes")
    # 找 MPEG 帧头
    f.seek(0)
    raw = f.read(4096)
    for i in range(len(raw) - 2):
        if raw[i] == 0xFF and (raw[i+1] & 0xE0) == 0xE0:
            print(f"MP3 帧头位置: {i}, 帧头: {raw[i]:02X}{raw[i+1]:02X}{raw[i+2]:02X}")
            break

print(f"\n时长: {dur:.1f} 秒 = {dur/60:.1f} 分钟")
print("验证通过!")