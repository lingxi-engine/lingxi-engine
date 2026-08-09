# -*- coding: utf-8 -*-
"""
《向着光》— 完整编曲
曲式: 前奏(4) 主歌A(8) 主歌B(8) 副歌1(8) 副歌2(8) 间奏(4) 副歌3(8) 尾奏(4) = 52 小节
BPM 96, 4/4, C 大调, 总长约 130 秒
声部: Kick / Snare / HiHat / Clap / Bass / Sub / Piano / Pad / Pluck / Lead / Bell
"""
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth_engine import *

SR = 44100
BPM = 96
BEAT = 60.0 / BPM
BAR = 4 * BEAT
TOTAL_BARS = 52
TOTAL_SAMPLES = int(TOTAL_BARS * BAR * SR)

# 和弦进行（小节号 -> 和弦，每小节一个）
# 和弦 = (根音midi, [组成音midi])
C  = (48, [60, 64, 67])   # C
G  = (43, [55, 59, 62])   # G/B 低音B
Am = (45, [57, 60, 64])   # Am
F  = (41, [53, 57, 60])   # F/A 低音A
G2 = (43, [55, 59, 62])   # G

# 52 小节和弦序列
chords = []
# 前奏 4
chords += [C, G, Am, F]
# 主歌A 8 (每2小节一换)
chords += [C, C, G, G, Am, Am, F, F]
# 主歌B 8
chords += [C, C, G, G, Am, Am, F, F]
# 副歌1 8
chords += [F, G, Am, Am, F, G, C, C]
# 副歌2 8
chords += [F, G, Am, Am, F, G, C, C]
# 间奏 4
chords += [Am, Am, F, G]
# 副歌3 8 (全能量)
chords += [F, G, Am, Am, F, G, C, C]
# 尾奏 4
chords += [C, G, Am, F]

def bar_to_sample(bar):
    return int(bar * BAR * SR)

def beat_to_sample(bar, beat):
    return int((bar * BAR + beat * BEAT) * SR)

def render_into(buf, x, start):
    """把单声道 x 放进立体声 buf（居中）"""
    n = min(len(x), len(buf[0]) - start)
    if n <= 0: return
    buf[0][start:start+n] += x[:n]
    buf[1][start:start+n] += x[:n]

def render_into_st(buf, x, start, pos):
    st = pan_mono(x, pos)
    n = min(len(x), len(buf[0]) - start)
    if n <= 0: return
    buf[0][start:start+n] += st[0][:n]
    buf[1][start:start+n] += st[1][:n]

def make_bus():
    return [np.zeros(TOTAL_SAMPLES), np.zeros(TOTAL_SAMPLES)]

# ============ 1. 鼓组 ============
def build_drums(section_map):
    """section_map: (起始小节, 结束小节, 强度) 或 ((起始, 结束), 强度)"""
    drums = make_bus()
    for item in section_map:
        if len(item) == 3:
            b0, b1, level = item
        else:
            (b0, b1), level = item
        for bar in range(b0, b1):
            # Kick: 每拍
            for beat in range(4):
                s = beat_to_sample(bar, beat)
                if beat == 0:
                    render_into(drums, kick(0.45) * (0.9 + 0.3 * level), s)
                elif beat == 2 and level > 0.4:
                    render_into(drums, kick(0.35) * 0.6 * level, s)
            # Snare: 2、4拍
            for beat in (1, 3):
                s = beat_to_sample(bar, beat)
                render_into(drums, snare(0.32) * (0.65 + 0.3 * level), s)
            # HiHat: 8分（重段16分）
            step = 0.5 if level < 0.9 else 0.25
            beat = 0.0
            while beat < 4.0:
                s = beat_to_sample(bar, beat)
                closed = (int(beat * 4) % 2 == 0) if level < 0.9 else (int(beat * 8) % 2 == 0)
                render_into(drums, hihat(0.1, closed) * (0.35 + 0.25 * level), s)
                beat += step
            # Clap: 重段 2、4 拍
            if level >= 0.9:
                for beat in (1, 3):
                    s = beat_to_sample(bar, beat)
                    render_into(drums, clap(0.28) * 0.5, s + int(0.03 * SR))
    return drums

# ============ 2. 贝斯 ============
def build_bass():
    bass_bus = make_bus()
    sub_bus = make_bus()
    for bar, ch in enumerate(chords):
        root = ch[0]
        for beat in range(4):
            s = beat_to_sample(bar, beat)
            f = midi_to_freq(root - 12)
            if beat in (0, 2):
                render_into(bass_bus, bass(f, BEAT * 0.9, 0.9), s)
                render_into(sub_bus, sub(midi_to_freq(root - 24), BEAT * 0.9, 0.8), s)
            else:
                render_into(bass_bus, bass(f, BEAT * 0.45, 0.6), s)
    return bass_bus, sub_bus

# ============ 3. 钢琴 ============
def build_piano():
    piano_bus = make_bus()
    for bar, ch in enumerate(chords):
        s = bar_to_sample(bar)
        notes = ch[1]
        # 前奏/间奏/尾奏：分解和弦 8分
        if bar < 4 or (36 <= bar < 40) or bar >= 48:
            pattern = [0, 2, 1, 2, 0, 2, 1, 2]  # 根音-五音-三音-五音
            for i, p in enumerate(pattern):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[p % len(notes)] + 12
                render_into_st(piano_bus, piano(midi_to_freq(n), 1.2, 0.55), t, -0.15 + 0.1 * (i % 2))
        # 主歌：分解 8分
        elif bar < 24:
            pattern = [0, 1, 2, 1, 0, 1, 2, 1]
            for i, p in enumerate(pattern):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[p % len(notes)] + 12
                render_into_st(piano_bus, piano(midi_to_freq(n), 0.9, 0.5), t, -0.1 + 0.2 * (i % 2))
        # 副歌：柱式和弦 4分
        else:
            for beat in range(4):
                t = beat_to_sample(bar, beat)
                for n in notes:
                    render_into_st(piano_bus, piano(midi_to_freq(n + 12), 1.6, 0.30), t, 0.05)
    return piano_bus

# ============ 4. 弦乐垫 ============
def build_pad():
    pad_bus = make_bus()
    # 垫在 副歌+前奏+间奏 持续；主歌减淡
    for bar, ch in enumerate(chords):
        active = bar >= 0  # 全部段落都有垫，音量不同
        if not active: continue
        s = bar_to_sample(bar)
        vol = 0.34
        if 4 <= bar < 24: vol = 0.22      # 主歌轻
        if 40 <= bar < 48: vol = 0.30     # 间奏
        if bar >= 48: vol = 0.26          # 尾奏
        freqs = [midi_to_freq(n) for n in ch[1]]
        render_into(pad_bus, pad(freqs, BAR * 1.05, vol), s)
    return pad_bus

# ============ 5. 琶音 Pluck（副歌） ============
def build_pluck():
    pluck_bus = make_bus()
    for bar in range(24, 40):   # 副歌1+2
        ch = chords[bar]
        s0 = bar_to_sample(bar)
        for i in range(16):     # 16分音符
            t = beat_to_sample(bar, i * 0.25)
            n = ch[1][i % 3] + 24
            render_into_st(pluck_bus, pluck(midi_to_freq(n), 0.35, 0.4), t, 0.3 + 0.15 * (i % 2))
    for bar in range(40, 48):   # 间奏：慢速琶音
        ch = chords[bar]
        for i in range(8):
            t = beat_to_sample(bar, i * 0.5)
            n = ch[1][i % 3] + 24
            render_into_st(pluck_bus, pluck(midi_to_freq(n), 0.4, 0.28), t, 0.2)
    for bar in range(48, 52):   # 副歌3 琶音
        ch = chords[bar]
        for i in range(16):
            t = beat_to_sample(bar, i * 0.25)
            n = ch[1][i % 3] + 24
            render_into_st(pluck_bus, pluck(midi_to_freq(n), 0.3, 0.42), t, 0.35 + 0.15 * (i % 2))
    return pluck_bus

# ============ 6. 主旋律 Lead ============
# 旋律事件: (bar, beat, dur_beats, midi, amp)  bar/beat 为起始
melody = {
    # 主歌A (bars 4-11) 每句2小节
    4:  [(0, 2.0, 76, 0.65), (2, 1.0, 79, 0.6), (3, 1.0, 76, 0.6), (4, 2.0, 74, 0.62), (6, 2.0, 72, 0.6)],
    6:  [(0, 2.0, 76, 0.6), (2, 1.0, 79, 0.58), (3, 1.0, 76, 0.6), (4, 2.0, 74, 0.6), (6, 1.0, 72, 0.55), (7, 1.0, 74, 0.55)],
    8:  [(0, 1.0, 79, 0.62), (1, 1.0, 81, 0.6), (2, 1.5, 79, 0.62), (3.5, 0.5, 76, 0.55), (4, 2.0, 74, 0.6), (6, 2.0, 76, 0.58)],
    10: [(0, 2.0, 76, 0.62), (2, 1.0, 79, 0.6), (3, 1.0, 76, 0.6), (4, 2.0, 74, 0.6), (6, 1.0, 72, 0.55), (7, 1.0, 74, 0.55)],
    # 主歌B (bars 12-19)
    12: [(0, 1.0, 72, 0.6), (1, 1.0, 76, 0.58), (2, 1.0, 79, 0.6), (3, 1.0, 76, 0.55), (4, 1.5, 74, 0.6), (5.5, 0.5, 72, 0.5), (6, 1.0, 74, 0.55), (7, 1.0, 76, 0.55)],
    14: [(0, 1.0, 72, 0.58), (1, 1.0, 76, 0.56), (2, 1.0, 79, 0.6), (3, 1.0, 76, 0.55), (4, 1.5, 74, 0.6), (6, 1.0, 72, 0.55), (7, 1.0, 74, 0.5)],
    16: [(0, 1.0, 76, 0.6), (1, 1.0, 79, 0.58), (2, 1.0, 81, 0.62), (3, 1.0, 79, 0.58), (4, 2.0, 76, 0.6), (6, 2.0, 74, 0.55)],
    18: [(0, 1.0, 76, 0.6), (1, 1.0, 79, 0.58), (2, 1.0, 81, 0.62), (3, 1.0, 79, 0.58), (4, 1.0, 81, 0.6), (5, 1.0, 79, 0.55), (6, 1.0, 76, 0.55), (7, 1.0, 74, 0.5)],
    # 副歌1 (bars 24-31) 每句2小节
    24: [(0, 1.0, 79, 0.68), (1, 1.0, 81, 0.66), (2, 1.5, 84, 0.7), (3.5, 0.5, 83, 0.62), (4, 1.0, 81, 0.66), (5, 1.0, 79, 0.62), (6, 2.0, 81, 0.6)],
    26: [(0, 1.0, 79, 0.66), (1, 1.0, 81, 0.64), (2, 1.5, 84, 0.68), (3.5, 0.5, 83, 0.6), (4, 1.0, 81, 0.64), (5, 1.0, 79, 0.6), (6, 1.0, 77, 0.58), (7, 1.0, 79, 0.58)],
    28: [(0, 1.0, 81, 0.66), (1, 1.0, 84, 0.64), (2, 1.5, 86, 0.68), (3.5, 0.5, 84, 0.6), (4, 1.0, 83, 0.64), (5, 1.0, 81, 0.6), (6, 2.0, 79, 0.58)],
    30: [(0, 1.0, 84, 0.66), (1, 1.0, 83, 0.62), (2, 1.0, 81, 0.64), (3, 1.0, 79, 0.6), (4, 1.0, 81, 0.62), (5, 1.0, 79, 0.58), (6, 1.0, 77, 0.56), (7, 1.0, 79, 0.56)],
    # 副歌2 (bars 32-39) 同副歌1 稍变
    32: [(0, 1.0, 79, 0.66), (1, 1.0, 81, 0.64), (2, 1.5, 84, 0.68), (3.5, 0.5, 83, 0.6), (4, 1.0, 81, 0.64), (5, 1.0, 79, 0.6), (6, 2.0, 81, 0.58)],
    34: [(0, 1.0, 79, 0.64), (1, 1.0, 81, 0.62), (2, 1.5, 84, 0.66), (3.5, 0.5, 83, 0.58), (4, 1.0, 81, 0.62), (5, 1.0, 79, 0.58), (6, 1.0, 77, 0.56), (7, 1.0, 79, 0.56)],
    36: [(0, 1.0, 81, 0.64), (1, 1.0, 84, 0.62), (2, 1.5, 86, 0.66), (3.5, 0.5, 84, 0.58), (4, 1.0, 83, 0.62), (5, 1.0, 81, 0.58), (6, 2.0, 79, 0.56)],
    38: [(0, 1.0, 84, 0.64), (1, 1.0, 83, 0.6), (2, 1.0, 81, 0.62), (3, 1.0, 79, 0.58), (4, 1.0, 81, 0.6), (5, 1.0, 79, 0.56), (6, 1.0, 77, 0.54), (7, 1.0, 79, 0.54)],
    # 副歌3 (bars 48-51) 升调：全部 +2 半音，能量最强
    48: [(0, 1.0, 81, 0.72), (1, 1.0, 83, 0.7), (2, 1.5, 86, 0.74), (3.5, 0.5, 85, 0.66), (4, 1.0, 83, 0.7), (5, 1.0, 81, 0.66), (6, 2.0, 83, 0.64)],
    49: [(0, 1.0, 81, 0.7), (1, 1.0, 83, 0.68), (2, 1.5, 86, 0.72), (3.5, 0.5, 85, 0.64), (4, 1.0, 83, 0.68), (5, 1.0, 81, 0.64), (6, 1.0, 79, 0.62), (7, 1.0, 81, 0.62)],
    50: [(0, 1.0, 83, 0.7), (1, 1.0, 86, 0.68), (2, 1.5, 88, 0.72), (3.5, 0.5, 86, 0.64), (4, 1.0, 85, 0.68), (5, 1.0, 83, 0.64), (6, 2.0, 81, 0.62)],
    51: [(0, 1.0, 86, 0.7), (1, 1.0, 85, 0.66), (2, 1.0, 83, 0.68), (3, 1.0, 81, 0.64), (4, 1.0, 83, 0.66), (5, 1.0, 81, 0.62), (6, 1.0, 79, 0.6), (7, 1.0, 81, 0.6)],
}

def build_lead():
    lead_bus = make_bus()
    for bar, events in melody.items():
        for ev in events:
            beat, dur, midi, amp = ev
            s = beat_to_sample(bar, beat)
            render_into_st(lead_bus, lead(midi_to_freq(midi), dur * BEAT, amp), s, 0.0)
    return lead_bus

# ============ 7. 铃音点缀（副歌3） ============
def build_bell():
    bell_bus = make_bus()
    for bar in range(48, 52):
        ch = chords[bar]
        for i, beat in enumerate([0.5, 1.5, 2.5, 3.5]):
            s = beat_to_sample(bar, beat)
            n = ch[1][i % 3] + 36
            render_into_st(bell_bus, bell(midi_to_freq(n), 1.8, 0.16), s, 0.4)
    return bell_bus

# ============ 主流程 ============
if __name__ == '__main__':
    print('渲染鼓组...')
    drums = build_drums([(4, 24, 0.55), (24, 40, 0.95), (40, 48, 0.5), (48, 52, 1.0)])
    print('渲染贝斯...')
    bass_bus, sub_bus = build_bass()
    print('渲染钢琴...')
    piano_bus = build_piano()
    print('渲染弦乐垫...')
    pad_bus = build_pad()
    print('渲染琶音...')
    pluck_bus = build_pluck()
    print('渲染主旋律...')
    lead_bus = build_lead()
    print('渲染铃音...')
    bell_bus = build_bell()

    print('效果处理与混音...')
    # 各声部效果与增益
    drums = [schroeder_reverb(d, mix=0.15, room=0.4) * 0.85 for d in drums]
    bass_bus = [lowpass(d, 300) * 1.1 for d in bass_bus]
    sub_bus = [lowpass(d, 160) * 1.0 for d in sub_bus]
    piano_bus = [schroeder_reverb(d, mix=0.25, room=0.55) * 0.8 for d in piano_bus]
    pad_bus = [schroeder_reverb(d, mix=0.35, room=0.7) * 0.7 for d in pad_bus]
    pluck_bus = [schroeder_reverb(d, mix=0.3, room=0.6) * 0.5 for d in pluck_bus]
    lead_bus = [delay(d, time=0.42, feedback=0.3, mix=0.22) for d in lead_bus]
    lead_bus = [schroeder_reverb(d, mix=0.2, room=0.5) * 1.0 for d in lead_bus]
    bell_bus = [schroeder_reverb(d, mix=0.35, room=0.6) * 0.9 for d in bell_bus]

    mix = [np.zeros(TOTAL_SAMPLES), np.zeros(TOTAL_SAMPLES)]
    for bus, g in [(drums, 1.0), (bass_bus, 1.0), (sub_bus, 0.9), (piano_bus, 1.0),
                   (pad_bus, 1.0), (pluck_bus, 1.0), (lead_bus, 1.0), (bell_bus, 1.0)]:
        mix[0] += bus[0] * g
        mix[1] += bus[1] * g

    # 立体声加宽 + 软削波 + 淡入淡出
    mix = stereo_widen(mix, 0.4)
    mix = [softclip(m, 1.5) for m in mix]
    mix = fade_in_out(mix, 0.8, 4.0)
    mix = normalize(mix, 0.95)

    # 保存
    import soundfile as sf
    out_dir = os.path.dirname(os.path.abspath(__file__))
    wav_path = os.path.join(out_dir, 'xiangzheguang_raw.wav')
    sf.write(wav_path, np.stack(mix, axis=1), SR)
    print('已输出:', wav_path)
    print('时长(秒):', len(mix[0]) / SR)
