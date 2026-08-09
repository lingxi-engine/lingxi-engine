# -*- coding: utf-8 -*-
"""为 MP3 补写 ID3v2 标签（歌名/艺术家/专辑/年份）"""
import os, struct

base = r"C:\Users\Administrator\lingxi-engine\workspace\music"
mp3_path = os.path.join(base, "xiangzheguang.mp3")

def make_id3v2(title, artist, album, year, comment):
    # 文本帧: "TIT2"/"TPE1"/"TALB"/"TYER" + 大小 + 标志 + 编码(3=UTF-8) + 文本
    frames = b""
    for fid, text in [("TIT2", title), ("TPE1", artist), ("TALB", album), ("TYER", year), ("COMM", comment)]:
        payload = b"\x03" + text.encode("utf-8")
        frames += fid.encode() + struct.pack(">I", len(payload)) + b"\x00\x00" + payload
    header = b"ID3" + b"\x03\x00" + b"\x00" + struct.pack(">I", len(frames))
    return header + frames

with open(mp3_path, "rb") as f:
    data = f.read()

# 去掉可能存在的旧 ID3 头
if data[:3] == b"ID3":
    size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
    data = data[10 + size:]

tag = make_id3v2("向着光", "Lingxi Engine", "本地合成 - 全本地音乐制作", "2026",
                 "52小节 C大调 BPM96 全本地合成编曲混音")
with open(mp3_path, "wb") as f:
    f.write(tag + data)

# 重新校验
with open(mp3_path, "rb") as f:
    head = f.read(3)
print("ID3 标签写入:", "成功" if head == b"ID3" else "失败")
print("MP3 大小: %.2f MB" % (os.path.getsize(mp3_path) / 1024 / 1024))
