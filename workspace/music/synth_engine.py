# -*- coding: utf-8 -*-
"""
本地编曲合成引擎 — 纯 numpy 实现，无网络依赖
乐器库：Kick / Snare / HiHat / Clap / Bass / Piano / Pad / Pluck / Lead / Sub / Bell
效果器：ADSR / 低通 / 混响(Schroeder) / 延迟 / 声像 / 立体声增强
"""
import numpy as np

SR = 44100

def midi_to_freq(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)

def _t(dur):
    n = int(dur * SR)
    return np.arange(n) / SR

def adsr(n, a=0.01, d=0.1, s=0.7, r=0.2, peak=1.0):
    """ADSR 包络"""
    env = np.ones(n)
    na = max(1, int(a * SR)); nd = max(1, int(d * SR)); nr = max(1, int(r * SR))
    # 确保 nr 不超过 n
    nr = min(nr, n)
    na = min(na, n)
    nd = min(nd, n - na)
    ns = max(0, n - na - nd - nr)
    if na > 0:
        env[:na] = np.linspace(0, 1, na)
    if nd > 0:
        env[na:na+nd] = np.linspace(1, s, nd)
    if ns > 0:
        env[na+nd:na+nd+ns] = s
    if nr > 0:
        start_val = env[-nr-1] if n > nr else s
        env[-nr:] = np.linspace(start_val, 0, nr)
    return env * peak

def lowpass(x, cutoff):
    """一阶 IIR 低通"""
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += alpha * (x[i] - acc)
        y[i] = acc
    return y

def highpass(x, cutoff):
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    prev_x = 0.0; prev_y = 0.0
    for i in range(len(x)):
        y[i] = alpha * (y[i-1] if i > 0 else 0.0) + alpha * (x[i] - prev_x)
        prev_x = x[i]
    return y

def softclip(x, drive=2.0):
    return np.tanh(x * drive) / np.tanh(drive)

# ---------------- 打击乐 ----------------
def kick(dur=0.5):
    t = _t(dur)
    freq = 150.0 * np.exp(-t * 18.0) + 45.0
    phase = 2 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-t * 8.0)
    click = np.random.randn(len(t)) * np.exp(-t * 90.0) * 0.4
    return (body + click) * 1.0

def snare(dur=0.35):
    t = _t(dur)
    noise = np.random.randn(len(t)) * np.exp(-t * 22.0)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30.0) * 0.7
    return (noise * 0.7 + tone) * 1.0

def hihat(dur=0.12, closed=True):
    t = _t(dur if closed else 0.25)
    noise = np.random.randn(len(t))
    noise = highpass(noise, 7000)
    decay = np.exp(-t * (55 if closed else 22))
    return noise * decay * 0.5

def clap(dur=0.3):
    t = _t(dur)
    out = np.zeros(len(t))
    for delay in (0, 0.011, 0.022, 0.033):
        n0 = int(delay * SR)
        if n0 >= len(t):
            continue
        seg = np.random.randn(len(t) - n0) * np.exp(-t[:len(t)-n0] * 40)
        out[n0:] += seg
    out = highpass(out, 1200)
    return out * 0.8

# ---------------- 旋律/和声乐器 ----------------
def bass(f, dur=0.5, amp=1.0):
    t = _t(dur)
    saw = 2.0 * (t * f % 1.0) - 1.0
    saw += 0.5 * 2.0 * (t * f * 2 % 1.0) - 0.5
    x = lowpass(saw, 900)
    env = adsr(len(t), 0.005, 0.12, 0.75, 0.1) * amp
    return x * env

def sub(f, dur=0.5, amp=0.9):
    t = _t(dur)
    x = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2 * t)
    env = adsr(len(t), 0.01, 0.1, 0.85, 0.12) * amp
    return x * env

def piano(f, dur=2.0, amp=0.8):
    """钢琴：多谐波 + 锤击起音"""
    t = _t(dur)
    x = np.zeros(len(t))
    for h, w in [(1, 1.0), (2, 0.5), (3, 0.25), (4, 0.15), (5, 0.1), (6, 0.06)]:
        x += w * np.sin(2 * np.pi * f * h * t + 0.1 * h) * np.exp(-t * (2.0 + h * 1.6))
    env = adsr(len(t), 0.002, 0.3, 0.6, 0.5) * amp
    return x * env

def pad(freqs, dur=4.0, amp=0.5):
    """弦乐垫：多个音符的柔和锯齿 + 慢包络"""
    t = _t(dur)
    x = np.zeros(len(t))
    for f in freqs:
        for det in (-0.3, 0.3):
            saw = 2.0 * ((t * (f + det)) % 1.0) - 1.0
            x += saw
    x = lowpass(x, 2200)
    env = adsr(len(t), 0.5, 0.5, 0.9, 0.8) * amp
    return x / len(freqs) * env

def pluck(f, dur=0.5, amp=0.5):
    """拨弦/琶音：三角波 + 带通"""
    t = _t(dur)
    x = 2.0 * np.abs(2.0 * (t * f % 1.0) - 1.0) - 1.0
    x += 0.4 * np.sin(2 * np.pi * f * 2 * t)
    x = lowpass(x, 5200)
    env = np.exp(-t * 9.0) * amp
    return x * env

def lead(f, dur=1.0, amp=0.6):
    """主旋律：双锯齿 detune + 低通扫频（温暖，类似人声/合成器主奏）"""
    t = _t(dur)
    x = np.zeros(len(t))
    for det, w in [(-6, 0.5), (6, 0.5), (0, 1.0)]:
        x += w * (2.0 * ((t * (f + det)) % 1.0) - 1.0)
    # 低通截止频率随时间略开
    fc = 1800 + 2500 * np.exp(-t * 3.0)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        alpha = 1.0 - np.exp(-2.0 * np.pi * fc[i] / SR)
        acc += alpha * (x[i] - acc)
        y[i] = acc
    env = adsr(len(t), 0.04, 0.15, 0.75, 0.15) * amp
    return y * env

def bell(f, dur=1.5, amp=0.3):
    t = _t(dur)
    x = 0.6 * np.sin(2 * np.pi * f * t) * np.exp(-t * 2.2)
    x += 0.3 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3.5)
    x += 0.15 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 5.0)
    return x * amp

# ---------------- 效果器 ----------------
def schroeder_reverb(x, sr=SR, mix=0.3, room=0.7):
    """Schroeder 混响：4 梳状 + 2 全通"""
    delays = [int(0.0297 * sr), int(0.0371 * sr), int(0.0411 * sr), int(0.0437 * sr)]
    gains = [0.75 * room, 0.72 * room, 0.68 * room, 0.64 * room]
    y = np.zeros_like(x)
    for d, g in zip(delays, gains):
        buf = np.zeros(d)
        out = np.zeros_like(x)
        for i in range(len(x)):
            b = buf[i % d]
            buf[i % d] = x[i] + g * b
            out[i] = b
        y += out
    y /= len(delays)
    # 全通
    for d in [int(0.005 * sr), int(0.0017 * sr)]:
        g = 0.5
        buf = np.zeros(d)
        out = np.zeros_like(y)
        for i in range(len(y)):
            b = buf[i % d]
            buf[i % d] = y[i] + g * b
            out[i] = -g * y[i] + b
        y = out
    wet = y * mix
    return x * (1 - mix) + wet * 2.0

def delay(x, sr=SR, time=0.42, feedback=0.35, mix=0.25):
    d = int(time * sr)
    if d <= 0:
        return x
    y = np.copy(x)
    buf = np.zeros(d)
    for i in range(len(x)):
        b = buf[i % d]
        buf[i % d] = x[i] + feedback * b
        y[i] = x[i] + mix * b
    return y

def pan_mono(x, pos):
    """pos: -1..1"""
    left = np.sqrt(0.5 * (1 - pos))
    right = np.sqrt(0.5 * (1 + pos))
    return np.stack([x * left, x * right], axis=0)

def stereo_widen(x, amount=0.5, delay_ms=8.0):
    """Haas 立体声加宽"""
    d = int(delay_ms / 1000 * SR)
    if d <= 0:
        return x
    l, r = x[0], x[1]
    l2 = np.concatenate([l[d:], np.zeros(d)])
    r2 = np.concatenate([np.zeros(d), r[:-d]])
    mix = amount
    return np.stack([l * (1 - mix) + l2 * mix, r * (1 - mix) + r2 * mix], axis=0)

def place(x, pos, width=0.6):
    """单声道音源 -> 立体声定位"""
    st = pan_mono(x, pos)
    return stereo_widen(st, width)

def fade_in_out(x, fin=0.5, fout=2.5, sr=SR):
    x = np.copy(x)
    n_in = int(fin * sr); n_out = int(fout * sr)
    if n_in > 0 and n_in < x.shape[1]:
        x[:, :n_in] *= np.linspace(0, 1, n_in)
    if n_out > 0 and n_out < x.shape[1]:
        x[:, -n_out:] *= np.linspace(1, 0, n_out)
    return x

def normalize(x, peak=0.95):
    m = np.max(np.abs(x))
    if m > 0:
        return x * (peak / m)
    return x

def rms(x):
    return float(np.sqrt(np.mean(x ** 2)))