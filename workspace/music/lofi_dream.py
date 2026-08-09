# -*- coding: utf-8 -*-
"""
《Midnight Tape》— Lo-Fi Chill Hip-Hop
BPM 75, 4/4, A minor, 总长约 96 秒
曲式: 前奏(4) A段(8) B段(8) 间奏(4) A'段(8) 尾奏(4) = 36 小节
声部: Kick / Snare / HiHat(open) / Bass / Piano / Pad / Pluck / Lead / Vinyl crackle
"""
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth_engine import *

SR = 44100
BPM = 75
BEAT = 60.0 / BPM
BAR = 4 * BEAT
TOTAL_BARS = 36
TOTAL_SAMPLES = int(TOTAL_BARS * BAR * SR)

# A minor 和弦
Am = (45, [57, 60, 64])    # Am
Dm = (50, [62, 65, 69])    # Dm
F  = (53, [65, 69, 72])    # F
E  = (52, [64, 67, 71])    # E
C  = (48, [60, 64, 67])    # C
G  = (43, [55, 59, 62])    # G

# 36 小节和弦序列
chords = []
# 前奏 4: Am - Dm - F - E (经典 lo-fi 循环)
chords += [Am, Dm, F, E]
# A段 8
chords += [Am, Am, Dm, Dm, F, F, E, E]
# B段 8: 稍有变化
chords += [Am, C, Dm, F, Am, C, E, E]
# 间奏 4
chords += [Am, Dm, F, E]
# A'段 8
chords += [Am, Am, Dm, Dm, F, F, E, E]
# 尾奏 4
chords += [Am, Dm, F, Am]

def bar_to_sample(bar):
    return int(bar * BAR * SR)

def beat_to_sample(bar, beat):
    return int((bar * BAR + beat * BEAT) * SR)

def render_into(buf, x, start):
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

# ============ Vinyl 噪声底 ============
def build_vinyl():
    bus = make_bus()
    t = np.arange(TOTAL_SAMPLES) / SR
    # 粉红噪声
    noise = np.random.randn(TOTAL_SAMPLES)
    # 简易粉红噪声: 累加白噪声 + 低通
    noise = lowpass(noise, 6000)
    noise = noise / (np.max(np.abs(noise)) + 1e-8) * 0.04
    # 偶尔的咔嗒声
    for _ in range(80):
        pos = np.random.randint(0, TOTAL_SAMPLES - 100)
        click = np.random.randn(100) * np.exp(-np.arange(100) / 15.0) * 0.15
        noise[pos:pos+100] += click
    # 轻微的 L/R 差异（模拟磁带）
    bus[0] += noise * 0.9
    bus[1] += noise * 1.0
    return bus

# ============ 1. 鼓组 (Lo-Fi 风格) ============
def build_drums():
    drums = make_bus()
    # A段(4-11): 轻柔; B段(12-19): 中等; 间奏(20-23): 无鼓; A'段(24-31): 中等; 尾奏(32-35): 渐弱
    sections = [(4, 12, 0.5), (12, 20, 0.7), (24, 32, 0.65), (32, 36, 0.4)]
    for b0, b1, level in sections:
        for bar in range(b0, b1):
            # Kick: 1拍 + 3拍后半拍 (lofi boom-bap 感)
            s = beat_to_sample(bar, 0)
            render_into(drums, kick(0.55) * (0.85 + 0.2 * level), s)
            s = beat_to_sample(bar, 2.5)
            render_into(drums, kick(0.4) * (0.6 + 0.2 * level), s)
            # Snare: 2拍 + 4拍 (轻)
            for beat in (1, 3):
                s = beat_to_sample(bar, beat)
                render_into(drums, snare(0.3) * (0.5 + 0.25 * level), s)
            # HiHat: 开镲 8分，慵懒
            for i in range(8):
                s = beat_to_sample(bar, i * 0.5)
                vol = (0.2 + 0.15 * level) * (0.7 if i % 2 == 0 else 0.5)
                render_into(drums, hihat(0.15, closed=False) * vol, s)
    return drums

# ============ 2. 贝斯 (圆滑低音) ============
def build_bass():
    bass_bus = make_bus()
    for bar, ch in enumerate(chords):
        root = ch[0]
        f = midi_to_freq(root - 12)
        # 每小节一个长音 + 偶尔走音
        s = bar_to_sample(bar)
        # 主音持续
        render_into(bass_bus, bass(f, BAR * 0.95, 0.8), s)
        # 第3拍走五度
        s2 = beat_to_sample(bar, 2)
        render_into(bass_bus, bass(midi_to_freq(root - 5), BEAT * 0.9, 0.5), s2)
    return bass_bus

# ============ 3. 钢琴 (Lo-Fi 电钢琴感) ============
def build_piano():
    piano_bus = make_bus()
    for bar, ch in enumerate(chords):
        notes = ch[1]
        s = bar_to_sample(bar)
        if bar < 4 or (20 <= bar < 24) or bar >= 32:
            # 前奏/间奏/尾奏: 慢分解
            for i, n in enumerate(notes):
                t = beat_to_sample(bar, i * 1.0)
                render_into_st(piano_bus, piano(midi_to_freq(n + 12), 2.5, 0.45), t, -0.2 + 0.15 * i)
        elif bar < 20:
            # A/B段: 分解 8分 + 偶尔加九音
            pattern = [0, 1, 2, 1, 0, 2, 1, 2]
            for i, p in enumerate(pattern):
                t = beat_to_sample(bar, i * 0.5)
                n = notes[p % len(notes)] + 12
                # 偶尔加九音色彩
                if i == 4 and bar % 4 == 0:
                    n += 2  # 九音
                render_into_st(piano_bus, piano(midi_to_freq(n), 1.0, 0.38), t, -0.15 + 0.1 * (i % 2))
        else:
            # A'段: 更饱满的柱式
            for beat in (0, 2):
                t = beat_to_sample(bar, beat)
                for j, n in enumerate(notes):
                    render_into_st(piano_bus, piano(midi_to_freq(n + 12), 1.8, 0.30), t, -0.1 + 0.15 * j)
    return piano_bus

# ============ 4. 弦乐垫 (温暖氛围) ============
def build_pad():
    pad_bus = make_bus()
    for bar, ch in enumerate(chords):
        s = bar_to_sample(bar)
        vol = 0.25
        if bar < 4: vol = 0.30
        if 4 <= bar < 20: vol = 0.20
        if 20 <= bar < 24: vol = 0.28
        if 24 <= bar < 32: vol = 0.22
        if bar >= 32: vol = 0.25
        freqs = [midi_to_freq(n) for n in ch[1]]
        render_into(pad_bus, pad(freqs, BAR * 1.05, vol), s)
    return pad_bus

# ============ 5. 琶音 Pluck (B段 + A'段) ============
def build_pluck():
    pluck_bus = make_bus()
    for bar in range(12, 20):  # B段
        ch = chords[bar]
        for i in range(8):
            t = beat_to_sample(bar, i * 0.5)
            n = ch[1][i % 3] + 24
            render_into_st(pluck_bus, pluck(midi_to_freq(n), 0.5, 0.3), t, 0.25 + 0.1 * (i % 2))
    for bar in range(24, 32):  # A'段
        ch = chords[bar]
        for i in range(8):
            t = beat_to_sample(bar, i * 0.5)
            n = ch[1][i % 3] + 24
            render_into_st(pluck_bus, pluck(midi_to_freq(n), 0.45, 0.28), t, 0.2 + 0.1 * (i % 2))
    return pluck_bus

# ============ 6. 主旋律 Lead (慵懒口风琴感) ============
melody = {
    # 前奏: 无旋律
    # A段 (bars 4-11): 简单旋律线
    4:  [(0, 2.0, 69, 0.55), (2, 1.0, 72, 0.52), (3, 1.0, 69, 0.50)],
    6:  [(0, 1.5, 72, 0.52), (1.5, 0.5, 74, 0.50), (2, 2.0, 72, 0.50), (4, 2.0, 69, 0.48)],
    8:  [(0, 1.0, 69, 0.50), (1, 1.0, 67, 0.48), (2, 2.0, 65, 0.50), (4, 1.0, 67, 0.48), (5, 1.0, 69, 0.48), (6, 2.0, 72, 0.50)],
    10: [(0, 2.0, 69, 0.50), (2, 1.0, 72, 0.48), (3, 1.0, 74, 0.50), (4, 2.0, 72, 0.48), (6, 2.0, 69, 0.46)],
    # B段 (bars 12-19): 旋律上扬
    12: [(0, 1.0, 72, 0.55), (1, 1.0, 74, 0.52), (2, 1.5, 76, 0.55), (3.5, 0.5, 74, 0.50), (4, 2.0, 72, 0.52), (6, 2.0, 69, 0.50)],
    14: [(0, 1.0, 69, 0.52), (1, 1.0, 72, 0.50), (2, 2.0, 74, 0.52), (4, 1.0, 76, 0.55), (5, 1.0, 74, 0.50), (6, 2.0, 72, 0.48)],
    16: [(0, 1.5, 72, 0.52), (1.5, 0.5, 74, 0.50), (2, 1.0, 76, 0.55), (3, 1.0, 77, 0.55), (4, 2.0, 76, 0.52), (6, 2.0, 74, 0.50)],
    18: [(0, 1.0, 72, 0.50), (1, 1.0, 69, 0.48), (2, 2.0, 67, 0.50), (4, 1.0, 65, 0.46), (5, 1.0, 67, 0.46), (6, 2.0, 69, 0.48)],
    # A'段 (bars 24-31): 回归主题 + 变奏
    24: [(0, 2.0, 69, 0.55), (2, 1.0, 72, 0.52), (3, 1.0, 74, 0.52), (4, 2.0, 72, 0.50), (6, 2.0, 69, 0.48)],
    26: [(0, 1.0, 72, 0.52), (1, 1.0, 74, 0.50), (2, 1.5, 76, 0.55), (3.5, 0.5, 74, 0.50), (4, 2.0, 72, 0.50), (6, 2.0, 69, 0.48)],
    28: [(0, 1.0, 69, 0.50), (1, 1.0, 67, 0.48), (2, 2.0, 65, 0.50), (4, 1.0, 67, 0.48), (5, 1.0, 69, 0.48), (6, 1.0, 72, 0.50), (7, 1.0, 74, 0.50)],
    30: [(0, 2.0, 76, 0.55), (2, 1.0, 74, 0.52), (3, 1.0, 72, 0.50), (4, 2.0, 69, 0.50), (6, 2.0, 65, 0.46)],
}

def build_lead():
    lead_bus = make_bus()
    for bar, events in melody.items():
        for ev in events:
            beat, dur, midi, amp = ev
            s = beat_to_sample(bar, beat)
            render_into_st(lead_bus, lead(midi_to_freq(midi), dur * BEAT, amp), s, 0.05)
    return lead_bus

# ============ 主流程 ============
if __name__ == '__main__':
    print('渲染 Vinyl 噪声...')
    vinyl = build_vinyl()
    print('渲染鼓组...')
    drums = build_drums()
    print('渲染贝斯...')
    bass_bus = build_bass()
    print('渲染钢琴...')
    piano_bus = build_piano()
    print('渲染弦乐垫...')
    pad_bus = build_pad()
    print('渲染琶音...')
    pluck_bus = build_pluck()
    print('渲染主旋律...')
    lead_bus = build_lead()

    print('效果处理与混音...')
    # Lo-Fi 特征: 低通切高频 + 更多混响
    drums = [lowpass(d, 12000) for d in drums]
    drums = [schroeder_reverb(d, mix=0.12, room=0.35) * 0.80 for d in drums]
    bass_bus = [lowpass(d, 500) * 1.15 for d in bass_bus]
    piano_bus = [lowpass(d, 6000) for d in piano_bus]
    piano_bus = [schroeder_reverb(d, mix=0.30, room=0.6) * 0.85 for d in piano_bus]
    pad_bus = [lowpass(d, 4000) for d in pad_bus]
    pad_bus = [schroeder_reverb(d, mix=0.40, room=0.8) * 0.65 for d in pad_bus]
    pluck_bus = [lowpass(d, 8000) for d in pluck_bus]
    pluck_bus = [schroeder_reverb(d, mix=0.25, room=0.5) * 0.45 for d in pluck_bus]
    lead_bus = [delay(d, time=0.375, feedback=0.25, mix=0.18) for d in lead_bus]
    lead_bus = [lowpass(d, 7000) for d in lead_bus]
    lead_bus = [schroeder_reverb(d, mix=0.25, room=0.55) * 0.95 for d in lead_bus]

    mix = [np.zeros(TOTAL_SAMPLES), np.zeros(TOTAL_SAMPLES)]
    for bus, g in [(vinyl, 0.8), (drums, 0.90), (bass_bus, 0.95),
                   (piano_bus, 1.0), (pad_bus, 0.85), (pluck_bus, 0.70),
                   (lead_bus, 0.90)]:
        mix[0] += bus[0] * g
        mix[1] += bus[1] * g

    # 立体声加宽 + 软削波 + 淡入淡出
    mix = stereo_widen(mix, 0.35)
    # Lo-Fi: 轻微饱和
    mix = [softclip(m, 1.2) for m in mix]
    mix = fade_in_out(mix, 1.5, 5.0)
    mix = normalize(mix, 0.92)

    # 保存
    import soundfile as sf
    out_dir = os.path.dirname(os.path.abspath(__file__))
    wav_path = os.path.join(out_dir, 'midnight_tape.wav')
    sf.write(wav_path, np.stack(mix, axis=1), SR, subtype='PCM_16')
    print('已输出:', wav_path)
    print('时长(秒):', len(mix[0]) / SR)
    print('峰值:', float(np.max(np.abs(mix))))
    print('RMS:', float(np.sqrt(np.mean(np.stack(mix, axis=1) ** 2))))