# -*- coding: utf-8 -*-
"""验证 midnight_tape 成品"""
import wave, os

wav_path = r"C:\Users\Administrator\lingxi-engine\workspace\music\midnight_tape.wav"
mp3_path = r"C:\Users\Administrator\lingxi-engine\workspace\music\midnight_tape.mp3"

# WAV 验证
with wave.open(wav_path, 'rb') as wf:
    print(f"WAV: {wf.getnchannels()}ch, {wf.getframerate()}Hz, {wf.getsampwidth()*8}bit, {wf.getnframes()} frames, {wf.getnframes()/wf.getframerate():.1f}s")
print(f"WAV size: {os.path.getsize(wav_path) / 1024 / 1024:.2f} MB")

# MP3 验证
mp3_size = os.path.getsize(mp3_path)
with open(mp3_path, 'rb') as f:
    header = f.read(4)
print(f"MP3 header: {header.hex()} ({'VALID MPEG' if header[0] == 0xFF and (header[1] & 0xE0) == 0xE0 else 'INVALID'})")
print(f"MP3 size: {mp3_size / 1024 / 1024:.2f} MB")