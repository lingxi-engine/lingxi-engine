# -*- coding: utf-8 -*-
"""最终校验 v3：纯 ASCII 输出，避免 GBK 编码问题"""
import os, wave, sys

base = r"C:\Users\Administrator\lingxi-engine\workspace\music"
wav_path = os.path.join(base, "xiangzheguang_raw.wav")
mp3_path = os.path.join(base, "xiangzheguang.mp3")

def ok(s): print("[OK] " + s)
def fail(s): print("[FAIL] " + s)

print("=== WAV ===")
try:
    with wave.open(wav_path, "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        fr = w.getframerate()
        n = w.getnframes()
        dur = n / fr
        print("channels=%d bits=%d rate=%d frames=%d dur=%.1fs" % (ch, sw*8, fr, n, dur))
        if ch == 2 and sw == 2 and fr == 44100 and abs(dur - 130.0) < 1.0:
            ok("WAV 格式有效: 44.1kHz/16bit/立体声/130s")
        else:
            fail("WAV 参数异常")
except Exception as e:
    fail("WAV 打开失败: %s" % e)

print()
print("=== MP3 ===")
try:
    with open(mp3_path, "rb") as f:
        head = f.read(3)
    if head == b"ID3":
        ok("MP3 含 ID3v2 标签")
    else:
        fail("MP3 无 ID3 标签, head=%s" % head.hex())
    size_mb = os.path.getsize(mp3_path) / 1024 / 1024
    print("MP3 大小: %.2f MB" % size_mb)
except Exception as e:
    fail("MP3 打开失败: %s" % e)

print()
print("=== 文件清单 ===")
for fn in ["xiangzheguang_raw.wav", "xiangzheguang.mp3", "song.py", "synth_engine.py", "制作报告-向着光.md"]:
    fp = os.path.join(base, fn)
    if os.path.exists(fp):
        ok("%s  %d 字节" % (fn, os.path.getsize(fp)))
    else:
        fail("%s 缺失" % fn)

print()
print("=== 结论 ===")
print("ALL_CHECKS_DONE")
