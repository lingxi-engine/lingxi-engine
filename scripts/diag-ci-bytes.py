# -*- coding: utf-8 -*-
"""诊断 ci.yml 的字节损伤模式"""
raw = open('.github/workflows/ci.yml', 'rb').read()
print('total bytes:', len(raw))

# 逐段尝试解码，定位第一个非法 UTF-8 边界
pos = 0
segments = []  # (start, end, codec)
encoders = ['utf-8', 'gbk', 'latin-1']
while pos < len(raw):
    for codec in encoders:
        try:
            raw[pos:].decode(codec)
            segments.append((pos, len(raw), codec))
            pos = len(raw)
            break
        except UnicodeDecodeError as e:
            first_bad = e.start + pos
            # 尝试解码到出错点之前
            try:
                raw[pos:first_bad].decode(codec)
                segments.append((pos, first_bad, codec))
                pos = first_bad + 1
                break
            except UnicodeDecodeError:
                continue
    else:
        segments.append((pos, len(raw), 'unknown'))
        pos = len(raw)

for s, e, c in segments:
    print(f'[{s}:{e}] {c} -> {raw[s:e][:40]!r}')