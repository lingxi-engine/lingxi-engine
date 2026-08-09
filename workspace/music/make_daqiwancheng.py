# -*- coding: utf-8 -*-
"""
《大器晚成》— 完整歌曲（伴奏 + AI朗读人声）
风格: Epic Cinematic Pop
BPM 80, D大调, 4/4, 240秒
"""
import numpy as np, sys, os, asyncio, edge_tts, soundfile as sf, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synth_engine import *
OUT = os.path.dirname(os.path.abspath(__file__))

SR = 44100; BPM = 80
BEAT = 60.0 / BPM; BAR = 4 * BEAT
TOTAL_BARS = 80; TOTAL_SAMPLES = int(TOTAL_BARS * BAR * SR)

# ========== 和声进行 ==========
# D大调: D(I) A(V) Bm(vi) G(IV)
D  = (50, [62,66,69]); A  = (45, [57,61,64]); Bm = (47, [59,62,66]); G  = (43, [55,59,62])
Em = (40, [52,55,59]); A7 = (45, [57,61,64,67])
chords = []
# 前奏4 / 主歌1 8 / 预副歌4 / 副歌1 8 = 24
chords += [D,D,G,G,D,D,A,A]           # 主歌1
chords += [Bm,Bm,G,G,A,A,A,A]         # 预副歌+副歌1
# 间奏4 / 主歌2 8 / 预副歌4 / 副歌2 8 = 24
chords += [D,D,G,G]                   # 间奏
chords += [D,D,G,G,D,D,A,A]           # 主歌2
chords += [Bm,Bm,G,G,A,A,A,A]         # 预副歌+副歌2
# 桥段8 / Solo8 / 副歌3升调8 / 尾奏8 = 32
chords += [Bm,Bm,G,G,Em,Em,A,A]       # 桥段
chords += [D,D,G,G,D,D,A,A]           # Solo
chords += [Bm,Bm,G,G,A,A7,D,D]        # 副歌3（高潮）
chords += [D,D,G,G,D,D,D,D]           # 尾奏

assert len(chords) == TOTAL_BARS

def bs(bar): return int(bar * BAR * SR)
def bt(bar, beat): return int((bar * BAR + beat * BEAT) * SR)

def rend(buf, x, start, pan=0.0):
    n = min(len(x), len(buf[0]) - start)
    if n <= 0: return
    if pan == 0.0:
        buf[0][start:start+n] += x[:n]
        buf[1][start:start+n] += x[:n]
    else:
        l = np.sqrt(0.5*(1-pan)); r = np.sqrt(0.5*(1+pan))
        buf[0][start:start+n] += x[:n]*l
        buf[1][start:start+n] += x[:n]*r

def bus(): return [np.zeros(TOTAL_SAMPLES), np.zeros(TOTAL_SAMPLES)]

# ====== 鼓组 ======
def make_drums():
    d = bus()
    for bar in range(TOTAL_BARS):
        lev = 0.55
        if 16 <= bar < 24 or 48 <= bar < 56: lev = 0.95
        if 56 <= bar < 64: lev = 0.6
        if 64 <= bar < 72: lev = 1.0
        if bar >= 72: lev = 0.5
        for beat in range(4):
            s = bt(bar, beat)
            if beat == 0: rend(d, kick(0.45)*(0.9+0.3*lev), s)
            elif beat == 2 and lev > 0.4: rend(d, kick(0.35)*0.6*lev, s)
        for beat in (1,3):
            rend(d, snare(0.32)*(0.65+0.3*lev), bt(bar, beat))
        step = 0.5 if lev < 0.9 else 0.25
        be = 0.0
        while be < 4.0:
            cl = (int(be*4)%2==0) if lev<0.9 else (int(be*8)%2==0)
            rend(d, hihat(0.1, cl)*(0.35+0.25*lev), bt(bar, be))
            be += step
        if lev >= 0.9:
            for beat in (1,3):
                rend(d, clap(0.28)*0.5, bt(bar, beat)+int(0.03*SR))
    return d

# ====== 贝斯 ======
def make_bass():
    bass_b = bus(); sub_b = bus()
    for bar, ch in enumerate(chords):
        root = ch[0]
        for beat in range(4):
            s = bt(bar, beat); f = midi_to_freq(root-12)
            if beat in (0,2):
                rend(bass_b, bass(f, BEAT*0.9, 0.9), s)
                rend(sub_b, sub(midi_to_freq(root-24), BEAT*0.9, 0.8), s)
            else:
                rend(bass_b, bass(f, BEAT*0.45, 0.6), s)
    return bass_b, sub_b

# ====== 钢琴 ======
def make_piano():
    p = bus()
    for bar, ch in enumerate(chords):
        notes = ch[1]
        # 前奏/尾奏：分解
        if bar < 4 or bar >= 72:
            pat = [0,2,1,2,0,2,1,2]
            for i, pi in enumerate(pat):
                t = bt(bar, i*0.5)
                n = notes[pi%3]+12
                rend(p, piano(midi_to_freq(n), 1.2, 0.55), t, -0.15+0.1*(i%2))
        # 主歌：分解
        elif bar < 24 or (32 <= bar < 40):
            pat = [0,1,2,1,0,1,2,1]
            for i, pi in enumerate(pat):
                t = bt(bar, i*0.5)
                n = notes[pi%3]+12
                rend(p, piano(midi_to_freq(n), 0.9, 0.5), t, -0.1+0.2*(i%2))
        # 副歌：柱式
        else:
            for beat in range(4):
                t = bt(bar, beat)
                for n in notes:
                    rend(p, piano(midi_to_freq(n+12), 1.6, 0.30), t, 0.05)
    return p

# ====== 弦乐垫 ======
def make_pad():
    p = bus()
    for bar, ch in enumerate(chords):
        s = bs(bar); vol = 0.34
        if bar < 4 or bar >= 72: vol = 0.22
        if 24 <= bar < 32: vol = 0.22
        if 56 <= bar < 64: vol = 0.3
        freqs = [midi_to_freq(n) for n in ch[1]]
        rend(p, pad(freqs, BAR*1.05, vol), s)
    return p

# ====== 琶音 ======
def make_pluck():
    p = bus()
    for bar in range(16, 72):
        ch = chords[bar]
        if bar < 24 or (48 <= bar < 56):  # 副歌 + 间奏
            for i in range(16):
                t = bt(bar, i*0.25)
                n = ch[1][i%3]+24
                rend(p, pluck(midi_to_freq(n), 0.35, 0.4), t, 0.3+0.15*(i%2))
    return p

# ====== 主旋律 ======
melody = {
    4:  [(0,2.0,74,0.62),(2,1.0,76,0.58),(3,1.0,74,0.6),(4,2.0,71,0.6),(6,2.0,69,0.58)],
    6:  [(0,2.0,74,0.6),(2,1.0,76,0.56),(3,1.0,74,0.58),(4,2.0,71,0.58),(6,1.0,69,0.55),(7,1.0,71,0.55)],
    8:  [(0,1.0,76,0.6),(1,1.0,78,0.58),(2,1.5,76,0.62),(3.5,0.5,74,0.55),(4,2.0,71,0.6),(6,2.0,74,0.55)],
    10: [(0,2.0,74,0.6),(2,1.0,76,0.58),(3,1.0,74,0.6),(4,2.0,71,0.6),(6,1.0,69,0.55),(7,1.0,71,0.55)],
    36: [(0,2.0,74,0.6),(2,1.0,76,0.56),(3,1.0,74,0.58),(4,2.0,71,0.58),(6,2.0,69,0.55)],
    38: [(0,2.0,74,0.58),(2,1.0,76,0.55),(3,1.0,74,0.56),(4,2.0,71,0.56),(6,1.0,69,0.5),(7,1.0,71,0.5)],
    16: [(0,1.0,78,0.68),(1,1.0,81,0.66),(2,1.5,83,0.7),(3.5,0.5,81,0.62),(4,1.0,78,0.66),(5,1.0,76,0.62),(6,2.0,78,0.6)],
    18: [(0,1.0,78,0.66),(1,1.0,81,0.64),(2,1.5,83,0.68),(3.5,0.5,81,0.6),(4,1.0,78,0.64),(5,1.0,76,0.6),(6,1.0,74,0.58),(7,1.0,76,0.58)],
    48: [(0,1.0,78,0.68),(1,1.0,81,0.66),(2,1.5,83,0.7),(3.5,0.5,81,0.62),(4,1.0,78,0.66),(5,1.0,76,0.62),(6,2.0,78,0.6)],
    50: [(0,1.0,78,0.66),(1,1.0,81,0.64),(2,1.5,83,0.68),(3.5,0.5,81,0.6),(4,1.0,78,0.64),(5,1.0,76,0.6),(6,1.0,74,0.58),(7,1.0,76,0.58)],
    64: [(0,1.0,81,0.72),(1,1.0,83,0.7),(2,1.5,86,0.74),(3.5,0.5,85,0.66),(4,1.0,83,0.7),(5,1.0,81,0.66),(6,2.0,83,0.64)],
    65: [(0,1.0,81,0.7),(1,1.0,83,0.68),(2,1.5,86,0.72),(3.5,0.5,85,0.64),(4,1.0,83,0.68),(5,1.0,81,0.64),(6,1.0,79,0.62),(7,1.0,81,0.62)],
    66: [(0,1.0,83,0.7),(1,1.0,86,0.68),(2,1.5,88,0.72),(3.5,0.5,86,0.64),(4,1.0,85,0.68),(5,1.0,83,0.64),(6,2.0,81,0.62)],
    67: [(0,1.0,86,0.7),(1,1.0,85,0.66),(2,1.0,83,0.68),(3,1.0,81,0.64),(4,1.0,83,0.66),(5,1.0,81,0.62),(6,1.0,79,0.6),(7,1.0,81,0.6)],
    # 吉他 Solo: bars 56-63
    56: [(0,1.0,78,0.65),(1,0.5,81,0.6),(1.5,0.5,83,0.6),(2,1.0,86,0.65),(3,1.0,83,0.6),(4,1.0,81,0.62),(5,0.5,83,0.58),(5.5,0.5,86,0.58),(6,1.0,88,0.65),(7,1.0,86,0.62)],
    58: [(0,1.5,83,0.65),(1.5,0.5,81,0.6),(2,1.0,78,0.62),(3,1.0,76,0.6),(4,1.0,78,0.6),(5,1.0,76,0.58),(6,2.0,74,0.6)],
}

def make_lead():
    l = bus()
    for bar, events in melody.items():
        for ev in events:
            beat, dur, midi, amp = ev
            s = bt(bar, beat)
            rend(l, lead(midi_to_freq(midi), dur*BEAT, amp), s)
    return l

# ====== 铃音 ======
def make_bell():
    b = bus()
    for bar in range(64, 72):
        ch = chords[bar]
        for i, beat in enumerate([0.5, 1.5, 2.5, 3.5]):
            s = bt(bar, beat)
            n = ch[1][i%3]+36
            rend(b, bell(midi_to_freq(n), 1.8, 0.16), s, 0.4)
    return b

# ====== 主流程 ======
print("=== 渲染伴奏 ===")
print("鼓组..."); drums = make_drums()
print("贝斯..."); bass_b, sub_b = make_bass()
print("钢琴..."); piano_b = make_piano()
print("弦乐垫..."); pad_b = make_pad()
print("琶音..."); pluck_b = make_pluck()
print("主旋律..."); lead_b = make_lead()
print("铃音..."); bell_b = make_bell()

print("混音...")
drums = [schroeder_reverb(d, mix=0.15, room=0.4)*0.85 for d in drums]
bass_b = [lowpass(d, 300)*1.1 for d in bass_b]
sub_b = [lowpass(d, 160)*1.0 for d in sub_b]
piano_b = [schroeder_reverb(d, mix=0.25, room=0.55)*0.8 for d in piano_b]
pad_b = [schroeder_reverb(d, mix=0.35, room=0.7)*0.7 for d in pad_b]
pluck_b = [schroeder_reverb(d, mix=0.3, room=0.6)*0.5 for d in pluck_b]
lead_b = [delay(d, time=0.42, feedback=0.3, mix=0.22) for d in lead_b]
lead_b = [schroeder_reverb(d, mix=0.2, room=0.5)*1.0 for d in lead_b]
bell_b = [schroeder_reverb(d, mix=0.35, room=0.6)*0.9 for d in bell_b]

mix = bus()
for b,g in [(drums,1.0),(bass_b,1.0),(sub_b,0.9),(piano_b,1.0),(pad_b,1.0),(pluck_b,1.0),(lead_b,1.0),(bell_b,1.0)]:
    mix[0] += b[0]*g; mix[1] += b[1]*g

mix = stereo_widen(mix, 0.4)
mix = np.stack([softclip(m, 1.5) for m in mix])
mix = fade_in_out(mix, 0.8, 4.0)
mix = normalize(mix, 0.92)

sf.write(os.path.join(OUT, 'daqiwancheng_inst.wav'), mix.T, SR)
print(f"伴奏已输出: {len(mix[0])/SR:.1f}秒")

# ====== AI 朗读歌词 ======
print("\n=== 生成 AI 人声 ===")
lyrics_text = """
大器晚成，不怕起步晚，只怕你不敢。
曾经跌倒，曾经迷茫，但只要不放弃，终会看见光。
别人飞得快，我走得慢，但我一步一个脚印，从不动摇。
每一步都算数，每滴汗都不白流，我正在成为更好的自己。
大器晚成，我从来不怕迟，只要心还在跳动，梦就还在燃烧。
那些嘲笑和冷眼，都是我前进的燃料，让我飞得更高，更高。
流过泪的眼睛，才看得清远方，受过伤的心，才装得下海洋。
不要急，不要慌，你的时代终会到来，终会到来。
大器晚成，我从来不怕迟，只要心还在跳动，梦就还在燃烧。
让我再勇敢一点，再坚持一下，黎明就在前方，就在前方。
大器晚成，这就是我的故事，晚开的花，一样香，一样香。
""".strip()

async def gen_vocal():
    comm = edge_tts.Communicate(lyrics_text, "zh-CN-XiaoxiaoNeural", rate="+12%", pitch="+2Hz")
    vocal_path = os.path.join(OUT, 'daqiwancheng_vocal.wav')
    await comm.save(vocal_path)
    return vocal_path

vocal_path = asyncio.run(gen_vocal())
print(f"人声已生成: {vocal_path}")

# ====== 混音：伴奏 + 人声 ======
print("\n=== 合成最终成品 ===")
vocal, sr_v = sf.read(vocal_path)
if len(vocal.shape) == 1:
    vocal = np.stack([vocal, vocal], axis=1)
elif vocal.shape[1] > 2:
    vocal = vocal[:, :2]
# 重采样到 44100
if sr_v != SR:
    import scipy.signal as signal
    ratio = SR / sr_v
    n_out = int(len(vocal) * ratio)
    vocal = np.stack([signal.resample(vocal[:, 0], n_out), signal.resample(vocal[:, 1], n_out)], axis=1)

# 对齐长度
min_len = min(len(mix[0]), len(vocal))
vocal_aligned = vocal[:min_len]
inst_aligned = np.stack([mix[0][:min_len], mix[1][:min_len]], axis=1)

# 人声处理：加混响融入伴奏
vocal_proc = np.copy(vocal_aligned.T)
vocal_proc = np.stack([schroeder_reverb(v, mix=0.25, room=0.5) for v in vocal_proc])
# 人声增益
vocal_proc *= 0.45

final = inst_aligned.T + vocal_proc
final = normalize(final, 0.95)

sf.write(os.path.join(OUT, 'daqiwancheng.wav'), final.T, SR)
print(f"WAV 已输出: {len(final[0])/SR:.1f}秒")
print(f"文件: {os.path.join(OUT, 'daqiwancheng.wav')}")
print("DONE!")
