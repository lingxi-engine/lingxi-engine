# -*- coding: utf-8 -*-
"""最终校验：WAV/MP3 文件头 + 时长 + 完整性"""
import os, struct, wave, sys

base = r"C:\Users\Administrator\lingxi-engine\workspace\music"
wav_path = os.path.join(base, "xiangzheguang_raw.wav")
mp3_path = os.path.join(base, "xiangzheguang.mp3")

print("=== WAV 校验 ===")
try:
    with wave.open(wav_path, "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        fr = w.getframerate()
        n = w.getnframes()
        dur = n / fr
        print(f"通道数: {ch}, 采样位宽: {sw*8}bit, 采样率: {fr}Hz")
        print(f"帧数: {n}, 时长: {dur:.1f} 秒")
        print(f"WAV 有效 ✅" if ch == 2 and sw == 2 and fr == 44100 else "WAV 格式异常 ❌")
except Exception as e:
    print("WAV 打开失败:", e)

print()
print("=== MP3 校验 ===")
try:
    with open(mp3_path, "rb") as f:
        head = f.read(4)
    if head[:3] == b"ID3":
        print("MP3 含 ID3 标签 ✅")
    elif head[:2] == b"\xff\xfb" or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        print("MP3 帧头有效 ✅")
    else:
        print(f"MP3 头异常: {head.hex()} ❌")
    print(f"MP3 大小: {os.path.getsize(mp3_path):,} 字节 ({os.path.getsize(mp3_path)/1024/1024:.2f} MB)")
except Exception as e:
    print("MP3 打开失败:", e)

print()
print("=== 文件清单 ===")
for fn in ["xiangzheguang_raw.wav", "xiangzheguang.mp3", "song.py", "synth_engine.py", "制作报告-向着光.md"]:
    fp = os.path.join(base, fn)
    if os.path.exists(fp):
        print(f"✅ {fn}  {os.path.getsize(fp):,} 字节")
    else:
        print(f"❌ {fn} 缺失")
