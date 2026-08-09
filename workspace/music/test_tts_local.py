# -*- coding: utf-8 -*-
"""测试 pyttsx3 本地 TTS"""
import pyttsx3
engine = pyttsx3.init()
voices = engine.getProperty('voices')
for i, v in enumerate(voices):
    print(f"[{i}] {v.name} | {v.id} | {v.languages}")

# 测试生成
engine.setProperty('voice', voices[0].id)
engine.setProperty('rate', 150)
engine.save_to_file("曾经多少次跌倒在地上", "test_pyttsx3.wav")
engine.runAndWait()
import os
print("文件大小:", os.path.getsize("test_pyttsx3.wav"), "bytes")
print("OK")
