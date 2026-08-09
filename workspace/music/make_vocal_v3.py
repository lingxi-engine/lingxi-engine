# -*- coding: utf-8 -*-
"""大器晚成 - 合成"人声感"旋律 + 混入伴奏

纯本地、零网络。用锯齿波 + 共振峰滤波 + 颤音模拟人声质感。
"""
import numpy as np
import wave, math, os, time

SR = 44100
BPM = 80
SEC_PER_BAR = 60.0 / BPM * 4  # 3.0s/bar
BEAT_SEC = 60.0 / BPM  # 0.75s/beat

def midi_to_freq(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))

# ============ 旋律线 (MIDI音符+时长[拍数]) ============
# 格式: (开始小节, 开始拍(0-3), [(midi_note, duration_in_beats), ...], 力度/情绪)
melody = [
    # ---- 前奏(4) 钢琴独奏，无人声 ----
    
    # ---- 主歌1 (bars 4-12) 低音诉说 ----
    (4, 0, [(62,1.5),(65,0.5),(66,1.5),(69,1.5),(69,0.5),(69,0.5),(67,0.5),(67,1.0),(67,0.5)], 0.7),
    (6, 0, [(62,1.5),(65,0.5),(66,1.5),(69,1.5),(69,0.5),(69,0.5),(67,0.5),(65,1.0),(65,0.5)], 0.7),
    (7, 0, [(64,1.5),(67,0.5),(69,1.5),(71,1.5),(71,0.5),(71,0.5),(69,0.5),(69,1.0),(69,0.5)], 0.75),
    (8, 0, [(66,1.5),(69,0.5),(71,1.5),(73,1.5),(73,0.5),(73,0.5),(71,0.5),(69,1.0),(66,0.5)], 0.8),
    (10,0, [(69,2.0),(71,2.0),(73,2.0),(73,2.0)], 0.8),  # 蓄力连接
    
    # ---- 预副歌 (bars 12-16) 渐强 ----
    (12,0, [(69,1.0),(69,0.5),(71,1.0),(71,0.5),(73,1.5),(73,1.5)], 0.85),
    (13,0, [(71,1.0),(71,0.5),(73,0.5),(74,1.0),(76,1.5),(76,1.0),(74,0.5),(73,1.0)], 0.9),
    (14,0, [(69,1.0),(69,0.5),(71,1.0),(71,0.5),(73,1.5),(73,1.5)], 0.85),
    (15,0, [(71,1.0),(71,0.5),(73,0.5),(74,1.0),(76,1.5),(76,1.0),(74,0.5),(73,0.5),(71,1.0)], 0.9),
    
    # ---- 副歌1 (bars 16-24) 爆发 D大调 ----
    (16,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (17,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,1.0)], 1.0),
    (18,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (19,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,0.5),(78,1.0)], 1.0),
    (20,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (21,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,1.0)], 1.0),
    (22,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (23,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,0.5),(78,1.0),(76,0.5)], 1.0),
    
    # ---- 间奏 (bars 24-28) 无人声 ----
    
    # ---- 主歌2 (bars 28-36) ----
    (28,0, [(62,1.5),(65,0.5),(66,1.5),(69,1.5),(69,0.5),(69,0.5),(67,0.5),(67,1.0),(67,0.5)], 0.65),
    (30,0, [(62,1.5),(65,0.5),(66,1.5),(69,1.5),(69,0.5),(69,0.5),(67,0.5),(65,1.0),(65,0.5)], 0.65),
    (31,0, [(64,1.5),(67,0.5),(69,1.5),(71,1.5),(71,0.5),(71,0.5),(69,0.5),(69,1.0),(69,0.5)], 0.7),
    (32,0, [(66,1.5),(69,0.5),(71,1.5),(73,1.5),(73,0.5),(73,0.5),(71,0.5),(69,1.0),(66,0.5),(66,0.5)], 0.75),
    (34,0, [(69,2.0),(71,2.0),(73,2.0),(73,2.0)], 0.75),
    
    # ---- 预副歌2 (bars 36-40) ----
    (36,0, [(69,1.0),(69,0.5),(71,1.0),(71,0.5),(73,1.5),(73,1.5)], 0.85),
    (37,0, [(71,1.0),(71,0.5),(73,0.5),(74,1.0),(76,1.5),(76,1.0),(74,0.5),(73,1.0)], 0.9),
    (38,0, [(69,1.0),(69,0.5),(71,1.0),(71,0.5),(73,1.5),(73,1.5)], 0.85),
    (39,0, [(71,1.0),(71,0.5),(73,0.5),(74,1.0),(76,1.5),(76,1.0),(74,0.5),(73,0.5),(71,1.0)], 0.9),
    
    # ---- 副歌2 (bars 40-48) ----
    (40,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (41,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,1.0)], 1.0),
    (42,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (43,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,0.5),(78,1.0)], 1.0),
    (44,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (45,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,1.0)], 1.0),
    (46,0, [(74,1.0),(74,0.5),(74,0.5),(76,1.0),(76,0.5),(76,0.5),(78,2.0),(78,1.0)], 1.0),
    (47,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(79,2.0),(79,0.5),(78,1.0),(76,0.5)], 1.0),
    
    # ---- 桥段 (bars 48-56) 低沉 ----
    (48,0, [(66,2.0),(66,1.5),(66,0.5),(69,1.5),(67,1.0),(67,1.5)], 0.6),
    (50,0, [(66,2.0),(66,1.5),(66,0.5),(69,1.5),(67,1.0),(67,1.5)], 0.6),
    (52,0, [(67,1.5),(69,1.0),(69,0.5),(71,1.5),(71,1.0),(71,0.5),(71,1.0)], 0.7),
    (54,0, [(69,1.5),(71,1.0),(71,0.5),(73,1.5),(73,1.0),(73,0.5),(73,1.0),(73,0.5)], 0.8),
    
    # ---- 吉他Solo (bars 56-64) 伴唱哼鸣 ----
    (56,0, [(73,4.0),(76,4.0)], 0.6),
    (58,0, [(74,4.0),(78,4.0)], 0.6),
    (60,0, [(76,4.0),(79,4.0)], 0.7),
    (62,0, [(78,3.0),(76,1.0),(74,1.0),(73,3.0)], 0.8),
    
    # ---- 副歌3 升调(bars 64-72) E大调 ----
    (64,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(80,2.0),(80,1.0)], 1.0),
    (65,0, [(78,1.0),(78,0.5),(78,0.5),(80,1.0),(80,0.5),(80,0.5),(81,2.0),(81,1.0)], 1.0),
    (66,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(80,2.0),(80,1.0)], 1.0),
    (67,0, [(78,1.0),(78,0.5),(78,0.5),(80,1.0),(80,0.5),(80,0.5),(81,2.0),(81,0.5),(80,1.0)], 1.0),
    (68,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(80,2.0),(80,1.0)], 1.0),
    (69,0, [(78,1.0),(78,0.5),(78,0.5),(80,1.0),(80,0.5),(80,0.5),(81,2.0),(81,1.0)], 1.0),
    (70,0, [(76,1.0),(76,0.5),(76,0.5),(78,1.0),(78,0.5),(78,0.5),(80,2.0),(80,1.0)], 1.0),
    (71,0, [(78,1.0),(78,0.5),(78,0.5),(80,1.0),(80,0.5),(80,0.5),(81,2.0),(81,0.5),(80,1.0),(78,0.5)], 1.0),
    
    # ---- 尾奏 (bars 72-80) 渐弱哼鸣 ----
    (72,0, [(76,4.0),(74,4.0)], 0.7),
    (74,0, [(73,6.0)], 0.5),
    (76,0, [(71,6.0)], 0.35),
    (78,0, [(69,6.0)], 0.2),
]

# ============ 合成函数 ============

def saw_wave(freq, duration, sr=SR):
    """锯齿波"""
    t = np.arange(int(duration * sr)) / sr
    phase = freq * t % 1.0
    return (phase * 2.0 - 1.0).astype(np.float32)

def pulse_wave(freq, duration, duty=0.3, sr=SR):
    """脉冲波 (用于鼻音/胸腔共鸣)"""
    t = np.arange(int(duration * sr)) / sr
    phase = freq * t % 1.0
    return np.where(phase < duty, 1.0, -0.3).astype(np.float32)

def formant_filter(signal, sr=SR):
    """三个共振峰带通滤波器 (模拟"啊"元音: F1~700Hz, F2~1200Hz, F3~2500Hz)"""
    from scipy.signal import butter, filtfilt
    
    def bandpass(low, high, order=2):
        nyq = sr / 2
        b, a = butter(order, [low/nyq, high/nyq], btype='band')
        return b, a
    
    out = np.zeros_like(signal)
    
    # F1: 600-800Hz (元音高度)
    b1, a1 = bandpass(550, 850, 2)
    out += filtfilt(b1, a1, signal.astype(np.float64)) * 1.0
    
    # F2: 1100-1300Hz 
    b2, a2 = bandpass(1050, 1350, 2)
    out += filtfilt(b2, a2, signal.astype(np.float64)) * 0.7
    
    # F3: 2300-2700Hz (亮度)
    b3, a3 = bandpass(2200, 2800, 2)
    out += filtfilt(b3, a3, signal.astype(np.float64)) * 0.4
    
    return out.astype(np.float32)

def synth_vocal_note(midi_note, duration_sec, velocity=1.0, sr=SR):
    """合成一个音符的人声质感"""
    freq = midi_to_freq(midi_note)
    
    # 锯齿波主体 (模拟声带振动)
    saw = saw_wave(freq, duration_sec, sr)
    
    # 脉冲波叠加 (增加胸腔共鸣)
    pulse = pulse_wave(freq, duration_sec, 0.25, sr) * 0.4
    
    # 白噪声少量 (增加气息感)
    noise = np.random.randn(int(duration_sec * sr)).astype(np.float32) * 0.05
    
    combined = saw + pulse + noise
    
    # 共振峰滤波
    filtered = formant_filter(combined, sr)
    
    # 颤音 (5-6Hz, 小幅)
    t = np.arange(len(filtered)) / sr
    vibrato_depth = 0.003 * velocity  # 半音的小幅偏移
    vibrato = np.sin(2 * np.pi * 5.5 * t) * vibrato_depth
    
    # 包络: 快速起音 + 轻微衰减
    attack = int(0.03 * sr)
    release = int(0.05 * sr)
    sustain_start = attack
    sustain_end = len(filtered) - release
    
    env = np.ones(len(filtered), dtype=np.float32)
    if attack > 0:
        env[:attack] = np.linspace(0, 1, attack)
    if release > 0 and sustain_end > 0:
        env[sustain_end:] = np.linspace(1, 0, len(filtered) - sustain_end)
    
    filtered = filtered * env * velocity * 0.85
    
    return filtered

def synth_vocal_phrase(notes, velocity, sr=SR):
    """合成一个乐句，音符间有连音(slur)"""
    segments = []
    for midi, dur_beats in notes:
        dur_sec = dur_beats * BEAT_SEC
        seg = synth_vocal_note(midi, dur_sec, velocity, sr)
        segments.append(seg)
    return np.concatenate(segments)

def save_wav(path, data, sr=SR):
    data = np.clip(data, -32768, 32767).astype(np.int16)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    with wave.open(path, 'wb') as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data.tobytes())

def load_wav(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        data = data.reshape(-1, ch)
    return sr, data

# ============ 主程序 ============
if __name__ == "__main__":
    t0 = time.time()
    print("=" * 50)
    print("大器晚成 - vocoder风格人声合成")
    print("=" * 50)
    
    total_bars = 80
    total_sec = total_bars * SEC_PER_BAR
    print(f"总时长: {total_sec:.0f}秒 / {total_bars}小节 / BPM {BPM}")
    
    # Step 1: 合成完整人声旋律线
    print("\n[Step 1] 合成人声旋律...")
    vocal_track = np.zeros(int(total_sec * SR), dtype=np.float32)
    
    for bar_start, beat_offset, notes, velocity in melody:
        start_sec = bar_start * SEC_PER_BAR + beat_offset * BEAT_SEC
        phrase = synth_vocal_phrase(notes, velocity)
        
        out_start = int(start_sec * SR)
        out_end = out_start + len(phrase)
        if out_end > len(vocal_track):
            phrase = phrase[:len(vocal_track) - out_start]
            out_end = len(vocal_track)
        
        vocal_track[out_start:out_end] += phrase
        
        if bar_start % 8 == 0:
            print(f"  bar {bar_start}...")
    
    # 加混响
    print("  加混响...")
    delay_ms = 100
    ds = int(delay_ms / 1000 * SR)
    reverb = np.zeros_like(vocal_track)
    delay_ms2 = 65
    ds2 = int(delay_ms2 / 1000 * SR)
    reverb[ds:] += vocal_track[:-ds] * 0.2
    reverb[ds2:] += vocal_track[:-ds2] * 0.15
    vocal_track = vocal_track + reverb
    
    # 归一化人声
    maxv = np.abs(vocal_track).max()
    if maxv > 0:
        vocal_track = vocal_track / maxv * 25000.0
    
    vocal_path = "dqwc_synth_vocal.wav"
    save_wav(vocal_path, vocal_track)
    print(f"  纯人声: {vocal_path} ({os.path.getsize(vocal_path)//1024}KB)")
    
    # Step 2: 混音
    print("\n[Step 2] 混入伴奏...")
    inst_path = "daqiwancheng.wav"
    sr_i, inst = load_wav(inst_path)
    if inst.ndim == 1:
        inst = inst.reshape(-1, 1)
    
    min_len = min(len(vocal_track), inst.shape[0])
    vocal_st = np.column_stack([vocal_track[:min_len], vocal_track[:min_len]])
    inst = inst[:min_len]
    
    # 人声加一点延迟加宽
    delay_stereo = int(30 / 1000 * SR)
    vocal_r = np.roll(vocal_track[:min_len], delay_stereo)
    vocal_st = np.column_stack([vocal_track[:min_len], vocal_r])
    
    mixed = inst.astype(np.float64) * 0.72 + vocal_st.astype(np.float64) * 0.9
    mixed = np.tanh(mixed / 20000.0) * 20000.0
    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 31000.0
    
    out_wav = "daqiwancheng_vocal.wav"
    save_wav(out_wav, mixed.astype(np.float32))
    print(f"  WAV: {out_wav} ({os.path.getsize(out_wav)//1024}KB)")
    
    # Step 3: MP3
    print("\n[Step 3] 编码 MP3...")
    try:
        import lameenc
        enc = lameenc.Encoder()
        enc.set_bit_rate(192)
        enc.set_in_sample_rate(SR)
        enc.set_channels(2)
        enc.set_quality(2)
        audio_16 = np.clip(mixed, -32768, 32767).astype(np.int16)
        mp3_data = enc.encode(audio_16.tobytes()) + enc.flush()
        out_mp3 = "daqiwancheng_vocal.mp3"
        with open(out_mp3, 'wb') as f:
            f.write(mp3_data)
        print(f"  MP3: {out_mp3} ({os.path.getsize(out_mp3)//1024}KB)")
    except ImportError:
        print("  lameenc 不可用")
    
    # 复制到桌面
    import shutil
    for fn in [out_wav, out_mp3] if os.path.exists(out_mp3) else [out_wav]:
        dest = os.path.join(r"C:\Users\Administrator\Desktop", fn)
        shutil.copy2(fn, dest)
        print(f"  已复制: {dest}")
    
    print(f"\n总耗时: {time.time()-t0:.0f}秒")
    print("DONE - 带人声旋律的《大器晚成》")
