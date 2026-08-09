# -*- coding: utf-8 -*-
"""
《大器晚成》— Epic Cinematic Pop / Rock
BPM 80, 4/4, D Major, 总长约 240 秒 (4 分钟)

曲式 (80 小节):
  前奏     (4)  bars 0-3    — 钢琴独奏，寂静中萌芽
  主歌1    (8)  bars 4-11   — 加入鼓+贝斯，诉说感
  预副歌1  (4)  bars 12-15  — 弦乐升起，蓄力
  副歌1    (8)  bars 16-23  — 全乐队爆发
  间奏     (4)  bars 24-27  — 钢琴回落
  主歌2    (8)  bars 28-35  — 更饱满的诉说
  预副歌2  (4)  bars 36-39  — 弦乐+琶音蓄力
  副歌2    (8)  bars 40-47  — 全乐队 + lead 旋律
  桥段     (8)  bars 48-55  — 情感转折，小调色彩
  吉他solo (8)  bars 56-63  — 激昂 solo
  副歌3    (8)  bars 64-71  — 最终高潮，升调
  尾奏     (8)  bars 72-79  — 渐弱，归于平静

声部: Kick / Snare / HiHat / Clap / Bass / Sub / Piano / Pad / Pluck / Lead / Bell / GuitarSolo
"""
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth_engine import *

SR = 44100
BPM = 80
BEAT = 60.0 / BPM       # 0.75s
BAR = 4 * BEAT          # 3.0s
TOTAL_BARS = 80
TOTAL_SAMPLES = int(TOTAL_BARS * BAR * SR)

# D Major 和弦
D   = (38, [50, 54, 57])    # D:  D-F#-A
Bm  = (43, [47, 50, 54])    # Bm: B-D-F#
G   = (43, [50, 54, 57])    # G:  G-B-D  (低八度 root)
G2  = (55, [59, 62, 66])    # G:  G-B-D  (高八度)
A   = (45, [57, 61, 64])    # A:  A-C#-E
Em  = (47, [52, 55, 59])    # Em: E-G-B
Fm  = (49, [53, 56, 60])    # F#m: F#-A-C# (用于桥段小调色彩)
# 升调副歌: E Major
E_ch = (40, [52, 56, 59])   # E:  E-G#-B
Cm  = (48, [52, 55, 59])    # C#m: C#-E-G#
Amaj = (45, [57, 61, 64])   # A:  A-C#-E
Bmaj = (47, [59, 63, 66])   # B:  B-D#-F#

# 80 小节和弦序列
chords = [None] * 80

# 前奏 4: D - D - G - A (钢琴独奏)
chords[0:4] = [D, D, G2, A]

# 主歌1 8: D - Bm - G - A x2
chords[4:12] = [D, Bm, G2, A, D, Bm, G2, A]

# 预副歌1 4: G - D - Em - A
chords[12:16] = [G2, D, Em, A]

# 副歌1 8: D - G - Bm - A x2
chords[16:24] = [D, G2, Bm, A, D, G2, Bm, A]

# 间奏 4: D - G - D - G
chords[24:28] = [D, G2, D, G2]

# 主歌2 8: D - Bm - G - A x2
chords[28:36] = [D, Bm, G2, A, D, Bm, G2, A]

# 预副歌2 4: G - D - Em - A
chords[36:40] = [G2, D, Em, A]

# 副歌2 8: D - G - Bm - A x2
chords[40:48] = [D, G2, Bm, A, D, G2, Bm, A]

# 桥段 8: Bm - G - D - A x2 (小调色彩)
chords[48:56] = [Bm, G2, D, A, Bm, G2, Em, A]

# 吉他solo 8: D - G - Bm - A x2
chords[56:64] = [D, G2, Bm, A, D, G2, Bm, A]

# 副歌3 8 (升调 E Major): E - A - C#m - B x2
chords[64:72] = [E_ch, Amaj, Cm, Bmaj, E_ch, Amaj, Cm, Bmaj]

# 尾奏 8: E - A - E - B - E - A - E - E (渐弱)
chords[72:80] = [E_ch, Amaj, E_ch, Bmaj, E_ch, Amaj, E_ch, E_ch]

def bar_to_sample(bar):
    return int(bar * BAR * SR)

def beat_to_sample(bar, beat):
    return int((bar * BAR + beat * BEAT) * SR)

def make_bus():
    return [np.zeros(TOTAL_SAMPLES, dtype=np.float64),
            np.zeros(TOTAL_SAMPLES, dtype=np.float64)]

def render_mono(buf, x, start):
    n = min(len(x), len(buf[0]) - start)
    if n <= 0: return
    buf[0][start:start+n] += x[:n]
    buf[1][start:start+n] += x[:n]

def render_st(buf, x, start, pos):
    st = pan_mono(x, pos)
    n = min(len(x), len(buf[0]) - start)
    if n <= 0: return
    buf[0][start:start+n] += st[0][:n]
    buf[1][start:start+n] += st[1][:n]

# ============ 1. 鼓组 ============
def build_drums():
    drums = make_bus()
    for bar in range(TOTAL_BARS):
        # 前奏(0-3): 无鼓
        # 主歌1(4-11): 轻鼓
        # 预副歌(12-15): 渐强
        # 副歌(16-23): 全力
        # 间奏(24-27): 无鼓
        # 主歌2(28-35): 中等
        # 预副歌2(36-39): 渐强
        # 副歌2(40-47): 全力
        # 桥段(48-55): 中等，情感
        # solo(56-63): 全力
        # 副歌3(64-71): 最大力度
        # 尾奏(72-79): 渐弱

        if bar < 4 or (24 <= bar < 28):
            continue

        if bar >= 72:
            level = max(0, 0.7 - (bar - 72) * 0.1)
        elif bar >= 64:
            level = 1.0
        elif bar >= 56:
            level = 0.9
        elif bar >= 48:
            level = 0.65
        elif bar >= 40:
            level = 0.9
        elif bar >= 36:
            level = 0.55 + (bar - 36) * 0.1
        elif bar >= 28:
            level = 0.6
        elif bar >= 16:
            level = 0.85
        elif bar >= 12:
            level = 0.5 + (bar - 12) * 0.1
        else:
            level = 0.45

        if level <= 0:
            continue

        # Kick: 1拍 + 3拍
        s = beat_to_sample(bar, 0)
        render_mono(drums, kick(0.55) * (0.9 * level), s)
        s = beat_to_sample(bar, 2)
        render_mono(drums, kick(0.45) * (0.7 * level), s)

        # Snare: 2拍 + 4拍
        for beat in (1, 3):
            s = beat_to_sample(bar, beat)
            render_mono(drums, snare(0.35) * (0.6 * level), s)

        # HiHat: 8分音符
        for i in range(8):
            s = beat_to_sample(bar, i * 0.5)
            vol = (0.25 * level) * (0.8 if i % 2 == 0 else 0.5)
            render_mono(drums, hihat(0.12, closed=True) * vol, s)

        # Clap: 副歌段 2拍+4拍 叠加
        if level >= 0.7:
            for beat in (1, 3):
                s = beat_to_sample(bar, beat)
                render_mono(drums, clap(0.25) * (0.4 * level), s)

    return drums

# ============ 2. 贝斯 ============
def build_bass():
    bus = make_bus()
    for bar in range(TOTAL_BARS):
        ch = chords[bar]
        root = ch[0]
        f = midi_to_freq(root - 12)

        if bar < 4:
            # 前奏: 无贝斯
            continue

        s = bar_to_sample(bar)
        # 主音持续
        render_mono(bus, bass(f, BAR * 0.95, 0.75), s)
        # 第3拍走五度
        s2 = beat_to_sample(bar, 2)
        render_mono(bus, bass(midi_to_freq(root - 5), BEAT * 0.9, 0.5), s2)

        # 副歌段加 sub
        if (16 <= bar < 24) or (40 <= bar < 48) or (64 <= bar < 72):
            render_mono(bus, sub(midi_to_freq(root - 24), BAR * 0.95, 0.5), s)

    return bus

# ============ 3. 钢琴 ============
def build_piano():
    bus = make_bus()
    for bar in range(TOTAL_BARS):
        ch = chords[bar]
        notes = ch[1]

        if bar < 4:
            # 前奏: 慢分解，空灵
            for i, n in enumerate(notes):
                t = beat_to_sample(bar, i * 1.0)
                render_st(bus, piano(midi_to_freq(n + 12), 3.0, 0.50), t, -0.2 + 0.15 * i)

        elif bar < 12 or (28 <= bar < 36):
            # 主歌: 分解 8分
            pattern = [0, 1, 2, 1, 0, 2, 1, 2]
            for i, p in enumerate(pattern):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[p % len(notes)] + 12
                vol = 0.38
                render_st(bus, piano(midi_to_freq(n), 1.0, vol), t, -0.15 + 0.1 * (i % 2))

        elif (12 <= bar < 16) or (36 <= bar < 40):
            # 预副歌: 柱式 + 分解混合，渐强
            for beat in (0, 2):
                t = beat_to_sample(bar, beat)
                for j, n in enumerate(notes):
                    vol = 0.32 + (bar % 4) * 0.03
                    render_st(bus, piano(midi_to_freq(n + 12), 1.8, vol), t, -0.1 + 0.15 * j)
            # 加分解
            for i in range(4):
                t = beat_to_sample(bar, 1 + i * 0.5)
                n = notes[i % 3] + 12
                render_st(bus, piano(midi_to_freq(n), 0.5, 0.25), t, 0.1)

        elif (16 <= bar < 24) or (40 <= bar < 48) or (64 <= bar < 72):
            # 副歌: 饱满柱式
            for beat in (0, 2):
                t = beat_to_sample(bar, beat)
                for j, n in enumerate(notes):
                    render_st(bus, piano(midi_to_freq(n + 12), 2.0, 0.35), t, -0.1 + 0.15 * j)
            # 加高八度分解
            for i in range(8):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[i % 3] + 24
                render_st(bus, piano(midi_to_freq(n), 0.4, 0.18), t, 0.15 + 0.1 * (i % 2))

        elif 24 <= bar < 28:
            # 间奏: 慢分解
            for i, n in enumerate(notes):
                t = beat_to_sample(bar, i * 1.0)
                render_st(bus, piano(midi_to_freq(n + 12), 2.5, 0.42), t, -0.2 + 0.15 * i)

        elif 48 <= bar < 56:
            # 桥段: 情感分解，低八度
            pattern = [0, 1, 2, 1, 2, 1, 0, 1]
            for i, p in enumerate(pattern):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[p % len(notes)] + 12
                render_st(bus, piano(midi_to_freq(n), 1.0, 0.35), t, -0.15 + 0.1 * (i % 2))

        elif 56 <= bar < 64:
            # solo 段: 节奏柱式
            for beat in (0, 1, 2, 3):
                t = beat_to_sample(bar, beat)
                for j, n in enumerate(notes):
                    render_st(bus, piano(midi_to_freq(n + 12), 0.7, 0.30), t, -0.1 + 0.15 * j)

        elif bar >= 72:
            # 尾奏: 渐弱慢分解
            vol = max(0.1, 0.45 - (bar - 72) * 0.05)
            for i, n in enumerate(notes):
                t = beat_to_sample(bar, i * 1.0)
                render_st(bus, piano(midi_to_freq(n + 12), 3.0, vol), t, -0.2 + 0.15 * i)

    return bus

# ============ 4. 弦乐垫 ============
def build_pad():
    bus = make_bus()
    for bar in range(TOTAL_BARS):
        ch = chords[bar]
        freqs = [midi_to_freq(n) for n in ch[1]]

        if bar < 4:
            vol = 0.20
        elif bar < 12:
            vol = 0.0  # 主歌1 无 pad
        elif bar < 16:
            vol = 0.15 + (bar - 12) * 0.04  # 预副歌渐入
        elif bar < 24:
            vol = 0.30  # 副歌
        elif bar < 28:
            vol = 0.15
        elif bar < 36:
            vol = 0.12
        elif bar < 40:
            vol = 0.18 + (bar - 36) * 0.04
        elif bar < 48:
            vol = 0.32
        elif bar < 56:
            vol = 0.35  # 桥段饱满
        elif bar < 64:
            vol = 0.30
        elif bar < 72:
            vol = 0.40  # 最终副歌最满
        else:
            vol = max(0.05, 0.35 - (bar - 72) * 0.04)

        if vol > 0:
            s = bar_to_sample(bar)
            render_mono(bus, pad(freqs, BAR * 1.05, vol), s)

    return bus

# ============ 5. 琶音 Pluck ============
def build_pluck():
    bus = make_bus()
    for bar in range(TOTAL_BARS):
        ch = chords[bar]
        notes = ch[1]

        # 预副歌 + 副歌 + 桥段 + solo + 最终副歌
        active = ((12 <= bar < 16) or (36 <= bar < 40) or
                  (16 <= bar < 24) or (40 <= bar < 48) or (64 <= bar < 72) or
                  (48 <= bar < 56) or (56 <= bar < 64))

        if not active:
            continue

        vol = 0.30
        if 12 <= bar < 16 or 36 <= bar < 40:
            vol = 0.25
        if 64 <= bar < 72:
            vol = 0.35

        for i in range(8):
            t = beat_to_sample(bar, i * 0.5)
            n = notes[i % 3] + 24
            render_st(bus, pluck(midi_to_freq(n), 0.5, vol), t, 0.25 + 0.1 * (i % 2))

    return bus

# ============ 6. 主旋律 Lead (充当人声旋律线) ============
# 旋律: (小节, 拍, 时长(拍), MIDI音符, 音量)
melody = [
    # 主歌1 (bars 4-11): 诉说感，中低音区
    (4, 0, 2.0, 62, 0.50), (4, 2, 1.0, 66, 0.48), (4, 3, 1.0, 69, 0.50),
    (5, 0, 1.0, 66, 0.48), (5, 1, 1.0, 62, 0.46), (5, 2, 2.0, 59, 0.48),
    (6, 0, 1.5, 62, 0.50), (6, 1.5, 0.5, 66, 0.48), (6, 2, 2.0, 69, 0.50),
    (7, 0, 1.0, 66, 0.48), (7, 1, 1.0, 62, 0.46), (7, 2, 1.0, 66, 0.48), (7, 3, 1.0, 69, 0.50),

    (8, 0, 2.0, 62, 0.50), (8, 2, 1.0, 66, 0.48), (8, 3, 1.0, 69, 0.50),
    (9, 0, 1.0, 66, 0.48), (9, 1, 1.0, 62, 0.46), (9, 2, 2.0, 59, 0.48),
    (10, 0, 1.5, 62, 0.50), (10, 1.5, 0.5, 66, 0.48), (10, 2, 1.0, 69, 0.50),
    (11, 0, 1.0, 71, 0.52), (11, 1, 1.0, 69, 0.50), (11, 2, 2.0, 66, 0.48),

    # 预副歌1 (bars 12-15): 上扬
    (12, 0, 1.0, 66, 0.52), (12, 1, 1.0, 69, 0.52), (12, 2, 1.0, 71, 0.54), (12, 3, 1.0, 73, 0.56),
    (13, 0, 2.0, 74, 0.58), (13, 2, 1.0, 73, 0.54), (13, 3, 1.0, 71, 0.52),
    (14, 0, 1.0, 69, 0.52), (14, 1, 1.0, 71, 0.54), (14, 2, 2.0, 73, 0.56),
    (15, 0, 1.0, 74, 0.58), (15, 1, 1.0, 73, 0.54), (15, 2, 1.0, 71, 0.52), (15, 3, 1.0, 73, 0.54),

    # 副歌1 (bars 16-23): 高音区，激昂
    (16, 0, 2.0, 74, 0.60), (16, 2, 1.0, 78, 0.58), (16, 3, 1.0, 77, 0.56),
    (17, 0, 1.0, 74, 0.56), (17, 1, 1.0, 76, 0.58), (17, 2, 2.0, 78, 0.60),
    (18, 0, 1.0, 74, 0.56), (18, 1, 1.0, 73, 0.54), (18, 2, 1.0, 71, 0.52), (18, 3, 1.0, 73, 0.54),
    (19, 0, 2.0, 74, 0.58), (19, 2, 1.0, 78, 0.60), (19, 3, 1.0, 81, 0.62),

    (20, 0, 2.0, 78, 0.60), (20, 2, 1.0, 81, 0.62), (20, 3, 1.0, 78, 0.58),
    (21, 0, 1.0, 76, 0.56), (21, 1, 1.0, 74, 0.54), (21, 2, 2.0, 73, 0.54),
    (22, 0, 1.0, 74, 0.56), (22, 1, 1.0, 76, 0.56), (22, 2, 1.0, 78, 0.58), (22, 3, 1.0, 76, 0.54),
    (23, 0, 2.0, 74, 0.56), (23, 2, 2.0, 73, 0.52),

    # 主歌2 (bars 28-35): 变奏，稍高
    (28, 0, 2.0, 62, 0.50), (28, 2, 1.0, 66, 0.48), (28, 3, 1.0, 69, 0.50),
    (29, 0, 1.0, 71, 0.52), (29, 1, 1.0, 69, 0.50), (29, 2, 2.0, 66, 0.48),
    (30, 0, 1.5, 62, 0.50), (30, 1.5, 0.5, 66, 0.48), (30, 2, 1.0, 69, 0.50), (30, 3, 1.0, 71, 0.52),
    (31, 0, 1.0, 73, 0.54), (31, 1, 1.0, 71, 0.52), (31, 2, 2.0, 69, 0.50),

    (32, 0, 2.0, 62, 0.50), (32, 2, 1.0, 66, 0.48), (32, 3, 1.0, 69, 0.50),
    (33, 0, 1.0, 71, 0.52), (33, 1, 1.0, 73, 0.54), (33, 2, 2.0, 74, 0.56),
    (34, 0, 1.0, 73, 0.54), (34, 1, 1.0, 71, 0.52), (34, 2, 1.0, 69, 0.50), (34, 3, 1.0, 71, 0.52),
    (35, 0, 2.0, 73, 0.54), (35, 2, 2.0, 74, 0.56),

    # 预副歌2 (bars 36-39): 更强上扬
    (36, 0, 1.0, 69, 0.54), (36, 1, 1.0, 71, 0.54), (36, 2, 1.0, 73, 0.56), (36, 3, 1.0, 74, 0.58),
    (37, 0, 2.0, 76, 0.60), (37, 2, 1.0, 74, 0.56), (37, 3, 1.0, 73, 0.54),
    (38, 0, 1.0, 71, 0.54), (38, 1, 1.0, 73, 0.56), (38, 2, 2.0, 76, 0.60),
    (39, 0, 1.0, 78, 0.62), (39, 1, 1.0, 76, 0.58), (39, 2, 1.0, 74, 0.56), (39, 3, 1.0, 76, 0.58),

    # 副歌2 (bars 40-47): 更激昂
    (40, 0, 2.0, 78, 0.62), (40, 2, 1.0, 81, 0.62), (40, 3, 1.0, 78, 0.58),
    (41, 0, 1.0, 76, 0.58), (41, 1, 1.0, 78, 0.60), (41, 2, 2.0, 81, 0.62),
    (42, 0, 1.0, 78, 0.58), (42, 1, 1.0, 76, 0.56), (42, 2, 1.0, 74, 0.54), (42, 3, 1.0, 76, 0.56),
    (43, 0, 2.0, 78, 0.60), (43, 2, 1.0, 81, 0.62), (43, 3, 1.0, 83, 0.64),

    (44, 0, 2.0, 81, 0.62), (44, 2, 1.0, 83, 0.64), (44, 3, 1.0, 81, 0.60),
    (45, 0, 1.0, 78, 0.58), (45, 1, 1.0, 76, 0.56), (45, 2, 2.0, 74, 0.56),
    (46, 0, 1.0, 76, 0.56), (46, 1, 1.0, 78, 0.58), (46, 2, 1.0, 81, 0.60), (46, 3, 1.0, 78, 0.56),
    (47, 0, 4.0, 76, 0.54),

    # 桥段 (bars 48-55): 情感转折，低沉
    (48, 0, 2.0, 66, 0.50), (48, 2, 2.0, 69, 0.50),
    (49, 0, 1.0, 71, 0.52), (49, 1, 1.0, 69, 0.50), (49, 2, 2.0, 66, 0.48),
    (50, 0, 1.5, 62, 0.48), (50, 1.5, 0.5, 66, 0.48), (50, 2, 2.0, 69, 0.50),
    (51, 0, 1.0, 71, 0.52), (51, 1, 1.0, 73, 0.54), (51, 2, 1.0, 74, 0.56), (51, 3, 1.0, 76, 0.58),

    (52, 0, 2.0, 74, 0.56), (52, 2, 2.0, 71, 0.52),
    (53, 0, 1.0, 69, 0.50), (53, 1, 1.0, 71, 0.52), (53, 2, 2.0, 73, 0.54),
    (54, 0, 1.0, 74, 0.56), (54, 1, 1.0, 73, 0.54), (54, 2, 1.0, 71, 0.52), (54, 3, 1.0, 69, 0.50),
    (55, 0, 2.0, 71, 0.54), (55, 2, 2.0, 73, 0.56),

    # 副歌3 升调 (bars 64-71): E Major, 最高潮
    # E major: E=64, G#=68, B=71, C#m: C#=61, E=64, G#=68
    (64, 0, 2.0, 76, 0.64), (64, 2, 1.0, 80, 0.64), (64, 3, 1.0, 83, 0.66),
    (65, 0, 1.0, 80, 0.62), (65, 1, 1.0, 83, 0.64), (65, 2, 2.0, 85, 0.66),
    (66, 0, 1.0, 83, 0.64), (66, 1, 1.0, 80, 0.62), (66, 2, 1.0, 76, 0.60), (66, 3, 1.0, 80, 0.62),
    (67, 0, 2.0, 83, 0.64), (67, 2, 1.0, 85, 0.66), (67, 3, 1.0, 88, 0.68),

    (68, 0, 2.0, 85, 0.66), (68, 2, 1.0, 88, 0.68), (68, 3, 1.0, 85, 0.64),
    (69, 0, 1.0, 83, 0.62), (69, 1, 1.0, 80, 0.60), (69, 2, 2.0, 78, 0.60),
    (70, 0, 1.0, 80, 0.62), (70, 1, 1.0, 83, 0.64), (70, 2, 1.0, 85, 0.66), (70, 3, 1.0, 83, 0.62),
    (71, 0, 4.0, 80, 0.60),

    # 尾奏 (bars 72-79): 渐弱回望
    (72, 0, 2.0, 76, 0.50), (72, 2, 2.0, 80, 0.48),
    (74, 0, 2.0, 76, 0.40), (74, 2, 2.0, 73, 0.38),
    (76, 0, 4.0, 76, 0.30),
]

def build_lead():
    bus = make_bus()
    for bar, beat, dur, midi, amp in melody:
        s = beat_to_sample(bar, beat)
        render_st(bus, lead(midi_to_freq(midi), dur * BEAT, amp), s, 0.0)
    return bus

# ============ 7. 铃音 Bell (副歌点缀) ============
def build_bell():
    bus = make_bus()
    # 副歌1, 2, 3 的高潮点缀
    bell_bars = list(range(16, 24)) + list(range(40, 48)) + list(range(64, 72))
    for bar in bell_bars:
        ch = chords[bar]
        # 每小节第1拍和第3拍的高音
        for beat in (0, 2):
            t = beat_to_sample(bar, beat)
            n = ch[1][0] + 24
            vol = 0.20
            if bar >= 64:
                vol = 0.25
            render_st(bus, bell(midi_to_freq(n), 1.5, vol), t, 0.3)
    return bus

# ============ 8. 吉他 Solo (bars 56-63) ============
guitar_solo = [
    (56, 0, 1.0, 74, 0.55), (56, 1, 0.5, 76, 0.55), (56, 1.5, 0.5, 78, 0.58),
    (56, 2, 0.5, 81, 0.60), (56, 2.5, 0.5, 78, 0.58), (56, 3, 1.0, 76, 0.55),
    (57, 0, 0.5, 74, 0.55), (57, 0.5, 0.5, 76, 0.55), (57, 1, 0.5, 78, 0.58),
    (57, 1.5, 0.5, 81, 0.60), (57, 2, 1.0, 83, 0.62), (57, 3, 1.0, 81, 0.60),
    (58, 0, 1.0, 78, 0.58), (58, 1, 0.5, 81, 0.60), (58, 1.5, 0.5, 83, 0.62),
    (58, 2, 0.5, 85, 0.64), (58, 2.5, 0.5, 83, 0.62), (58, 3, 1.0, 81, 0.60),
    (59, 0, 0.5, 78, 0.58), (59, 0.5, 0.5, 76, 0.55), (59, 1, 0.5, 78, 0.58),
    (59, 1.5, 0.5, 81, 0.60), (59, 2, 2.0, 83, 0.62),
    (60, 0, 0.5, 85, 0.64), (60, 0.5, 0.5, 83, 0.62), (60, 1, 0.5, 81, 0.60),
    (60, 1.5, 0.5, 83, 0.62), (60, 2, 0.5, 85, 0.64), (60, 2.5, 0.5, 86, 0.66),
    (60, 3, 1.0, 88, 0.68),
    (61, 0, 1.0, 86, 0.66), (61, 1, 0.5, 85, 0.64), (61, 1.5, 0.5, 83, 0.62),
    (61, 2, 1.0, 81, 0.60), (61, 3, 1.0, 83, 0.62),
    (62, 0, 0.5, 85, 0.64), (62, 0.5, 0.5, 83, 0.62), (62, 1, 0.5, 81, 0.60),
    (62, 1.5, 0.5, 78, 0.58), (62, 2, 1.0, 76, 0.55), (62, 3, 1.0, 78, 0.58),
    (63, 0, 2.0, 81, 0.62), (63, 2, 2.0, 78, 0.58),
]

def build_guitar():
    bus = make_bus()
    for bar, beat, dur, midi, amp in guitar_solo:
        s = beat_to_sample(bar, beat)
        # 吉他用 lead 音色 + 更亮的滤波
        note = lead(midi_to_freq(midi), dur * BEAT, amp)
        render_st(bus, note, s, 0.1)
    return bus

# ============ 主流程 ============
if __name__ == '__main__':
    import time
    t0 = time.time()

    print('=== 《大器晚成》渲染开始 ===')
    print(f'BPM={BPM}, 调性=D Major, 小节数={TOTAL_BARS}, 预计时长={TOTAL_BARS*BAR:.0f}秒')

    print('[1/8] 渲染鼓组...')
    drums = build_drums()
    print('[2/8] 渲染贝斯...')
    bass_bus = build_bass()
    print('[3/8] 渲染钢琴...')
    piano_bus = build_piano()
    print('[4/8] 渲染弦乐垫...')
    pad_bus = build_pad()
    print('[5/8] 渲染琶音...')
    pluck_bus = build_pluck()
    print('[6/8] 渲染主旋律...')
    lead_bus = build_lead()
    print('[7/8] 渲染铃音...')
    bell_bus = build_bell()
    print('[8/8] 渲染吉他solo...')
    guitar_bus = build_guitar()

    print('效果处理与混音...')
    # 鼓组: 轻微混响
    drums = [lowpass(d, 14000) for d in drums]
    drums = [schroeder_reverb(d, mix=0.10, room=0.30) * 0.85 for d in drums]

    # 贝斯: 低通
    bass_bus = [lowpass(d, 600) * 1.10 for d in bass_bus]

    # 钢琴: 混响
    piano_bus = [lowpass(d, 8000) for d in piano_bus]
    piano_bus = [schroeder_reverb(d, mix=0.25, room=0.55) * 0.90 for d in piano_bus]

    # 弦乐垫: 大混响
    pad_bus = [lowpass(d, 5000) for d in pad_bus]
    pad_bus = [schroeder_reverb(d, mix=0.35, room=0.80) * 0.70 for d in pad_bus]

    # 琶音: 混响
    pluck_bus = [lowpass(d, 9000) for d in pluck_bus]
    pluck_bus = [schroeder_reverb(d, mix=0.28, room=0.50) * 0.50 for d in pluck_bus]

    # 主旋律: 延迟 + 混响
    lead_bus = [delay(d, time=0.375, feedback=0.30, mix=0.20) for d in lead_bus]
    lead_bus = [lowpass(d, 9000) for d in lead_bus]
    lead_bus = [schroeder_reverb(d, mix=0.22, room=0.50) * 0.95 for d in lead_bus]

    # 铃音: 大混响
    bell_bus = [schroeder_reverb(d, mix=0.40, room=0.70) * 0.60 for d in bell_bus]

    # 吉他: 延迟 + 混响
    guitar_bus = [delay(d, time=0.375, feedback=0.25, mix=0.15) for d in guitar_bus]
    guitar_bus = [lowpass(d, 8000) for d in guitar_bus]
    guitar_bus = [schroeder_reverb(d, mix=0.20, room=0.45) * 0.90 for d in guitar_bus]

    # 混音
    mix = [np.zeros(TOTAL_SAMPLES, dtype=np.float64),
           np.zeros(TOTAL_SAMPLES, dtype=np.float64)]

    for bus, g in [(drums, 0.85), (bass_bus, 0.90), (piano_bus, 1.0),
                   (pad_bus, 0.80), (pluck_bus, 0.60), (lead_bus, 0.95),
                   (bell_bus, 0.55), (guitar_bus, 0.85)]:
        mix[0] += bus[0] * g
        mix[1] += bus[1] * g

    # 立体声加宽
    mix = stereo_widen(mix, 0.30)
    # 软削波
    mix = [softclip(m, 1.5) for m in mix]
    # 淡入淡出
    mix = fade_in_out(mix, 2.0, 6.0)
    # 归一化
    mix = normalize(mix, 0.95)

    # 保存 WAV
    import soundfile as sf
    out_dir = os.path.dirname(os.path.abspath(__file__))
    wav_path = os.path.join(out_dir, 'daqiwancheng.wav')
    sf.write(wav_path, np.stack(mix, axis=1), SR, subtype='PCM_16')

    duration = len(mix[0]) / SR
    peak = float(np.max(np.abs(mix)))
    rms_val = float(np.sqrt(np.mean(np.stack(mix, axis=1) ** 2)))

    print(f'\n=== 渲染完成 ===')
    print(f'输出: {wav_path}')
    print(f'时长: {duration:.1f} 秒 ({duration/60:.1f} 分钟)')
    print(f'峰值: {peak:.3f}')
    print(f'RMS: {rms_val:.3f}')
    print(f'耗时: {time.time()-t0:.1f} 秒')