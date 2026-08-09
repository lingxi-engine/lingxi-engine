# -*- coding: utf-8 -*-
"""大器晚成 - 人声生成+混音 (修复版)

策略：
1. 用 edge-tts 生成每行歌词语音
2. 按旋律音高变调
3. 拼接到伴奏对应位置
4. 混音输出 WAV + MP3
"""
import asyncio, subprocess, sys, os, wave, struct, math, time
import numpy as np

os.chdir(r"C:\Users\Administrator\lingxi-engine\workspace\music")

SR = 44100
BPM = 80
SEC_PER_BAR = 60.0 / BPM * 4  # 3.0s

# ============ 歌词分段 ============
lyrics_segments = [
    # (开始小节, 文本, 旋律音高[MIDI], 描述)
    (4,  "曾经多少次跌倒在地上",    [62,62,65,66,69,69,69,69,67,67,67], "主歌"),
    (6,  "曾经多少次迷失了方向",    [62,62,65,66,69,69,69,69,67,65,65], "主歌"),
    (7,  "每一次黑夜都那么漫长",    [64,64,67,69,71,71,71,71,69,69,69], "主歌"),
    (8,  "心中那团火却从未熄灭过",  [66,66,69,71,73,73,73,73,71,69,66], "主歌"),
    (12, "我知道我知道",            [69,69,71,71,73,73,73], "预副歌"),
    (13, "风雨过后一定有彩虹",      [71,71,73,74,76,76,76,74,73], "预副歌"),
    (14, "我相信我相信",            [69,69,71,71,73,73,73], "预副歌"),
    (15, "总有一天会站上巅峰",      [71,71,73,74,76,76,76,74,73,71], "预副歌"),
    (16, "大器晚成我不怕等",        [74,74,74,76,76,76,78,78,78], "副歌"),
    (17, "每一步都是青春的见证",    [76,76,76,78,78,78,79,79,79], "副歌"),
    (18, "大器晚成热血在沸腾",      [74,74,74,76,76,76,78,78,78], "副歌"),
    (19, "这一生我绝不再退缩",      [76,76,76,78,78,78,79,79,79,78], "副歌"),
    (20, "大器晚成我不怕等",        [74,74,74,76,76,76,78,78,78], "副歌"),
    (21, "哪怕一路上多少伤痕",      [76,76,76,78,78,78,79,79,79], "副歌"),
    (22, "大器晚成冲破这围城",      [74,74,74,76,76,76,78,78,78], "副歌"),
    (23, "总有一天会让世界沸腾",    [76,76,76,78,78,78,79,79,79,78,76], "副歌"),
    (28, "曾经多少次对自己失望",    [62,62,65,66,69,69,69,69,67,67,67], "主歌2"),
    (30, "曾经多少次想要去放弃",    [62,62,65,66,69,69,69,69,67,65,65], "主歌2"),
    (31, "但每次想起最初的梦想",    [64,64,67,69,71,71,71,71,69,69,69], "主歌2"),
    (32, "就咬着牙告诉自己不能再逃",[66,66,69,71,73,73,73,73,71,69,66,66], "主歌2"),
    (36, "我知道我知道",            [69,69,71,71,73,73,73], "预副歌2"),
    (37, "风雨过后一定有彩虹",      [71,71,73,74,76,76,76,74,73], "预副歌2"),
    (38, "我相信我相信",            [69,69,71,71,73,73,73], "预副歌2"),
    (39, "这一次我绝不再放手",      [71,71,73,74,76,76,76,74,73,71], "预副歌2"),
    (40, "大器晚成我不怕等",        [74,74,74,76,76,76,78,78,78], "副歌2"),
    (41, "每一步都是青春的见证",    [76,76,76,78,78,78,79,79,79], "副歌2"),
    (42, "大器晚成热血在沸腾",      [74,74,74,76,76,76,78,78,78], "副歌2"),
    (43, "这一生我绝不再退缩",      [76,76,76,78,78,78,79,79,79,78], "副歌2"),
    (44, "大器晚成我不怕等",        [74,74,74,76,76,76,78,78,78], "副歌2"),
    (45, "哪怕一路上多少伤痕",      [76,76,76,78,78,78,79,79,79], "副歌2"),
    (46, "大器晚成冲破这围城",      [74,74,74,76,76,76,78,78,78], "副歌2"),
    (47, "总有一天会让世界沸腾",    [76,76,76,78,78,78,79,79,79,78,76], "副歌2"),
    (48, "也许还要走很长的路",      [66,66,66,66,69,69,67,67], "桥段"),
    (50, "也许还有无数个孤独",      [66,66,66,66,69,69,67,67], "桥段"),
    (52, "但我早已不怕等待",        [67,67,69,69,71,71,71,71], "桥段"),
    (54, "因为我相信大器晚成",      [69,69,71,71,73,73,73,73,73], "桥段"),
    (64, "大器晚成我不怕等",        [76,76,76,78,78,78,80,80,80], "副歌3升调"),
    (65, "每一步都是青春的见证",    [78,78,78,80,80,80,81,81,81], "副歌3升调"),
    (66, "大器晚成热血在沸腾",      [76,76,76,78,78,78,80,80,80], "副歌3升调"),
    (67, "这一生我绝不再退缩",      [78,78,78,80,80,80,81,81,81,80], "副歌3升调"),
    (68, "大器晚成我不怕等",        [76,76,76,78,78,78,80,80,80], "副歌3升调"),
    (69, "哪怕一路上多少伤痕",      [78,78,78,80,80,80,81,81,81], "副歌3升调"),
    (70, "大器晚成冲破这围城",      [76,76,76,78,78,78,80,80,80], "副歌3升调"),
    (71, "这一天终于让世界沸腾",    [78,78,78,80,80,80,81,81,81,80,78], "副歌3升调"),
]

# ============ 核心函数 ============

def midi_to_semitones_from_ref(midi_note, reference_hz=150.0):
    """把 MIDI 音高转为相对于参考频率的半音偏移"""
    target_hz = 440.0 * (2.0 ** ((midi_note - 69) / 12.0))
    return 12.0 * math.log2(target_hz / reference_hz)

def simple_pitch_shift(audio, sr, semitones):
    """极简变调：对单声道 float32 音频做半音偏移"""
    if abs(semitones) < 0.02:
        return audio.copy()
    from scipy.signal import resample_poly
    factor = 2.0 ** (semitones / 12.0)
    # 拉伸/压缩波形（改变音高+时长）
    new_len = max(1, int(len(audio) / factor))
    stretched = resample_poly(audio.astype(np.float64), len(audio), new_len)
    # 再插值回原长（修正时长）
    result = resample_poly(stretched, new_len, len(audio))
    return result.astype(np.float32)

def load_wav(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return sr, data

def save_wav(path, data, sr=SR):
    data = np.clip(data, -32768, 32767).astype(np.int16)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    with wave.open(path, 'wb') as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data.tobytes())

async def gen_tts(text, out_wav, voice="zh-CN-YunxiNeural", rate="-15%"):
    """生成 TTS 语音"""
    cmd = ["edge-tts", "--voice", voice, "--text", text,
           "--write-media", out_wav, "--rate", rate]
    proc = await asyncio.create_subprocess_exec(*cmd)
    await proc.communicate()
    return proc.returncode == 0 and os.path.exists(out_wav)

async def synth_all_vocals():
    """串行生成所有 TTS 片段，变调后拼接"""
    total_sec = 80 * SEC_PER_BAR  # 240s
    vocal_track = np.zeros(int(total_sec * SR), dtype=np.float32)
    beat_dur = 60.0 / BPM
    
    for bar_start, text, notes, desc in lyrics_segments:
        start_time = bar_start * SEC_PER_BAR
        seg_dur = len(notes) * beat_dur
        tmp = f"__tmp_{bar_start}.wav"
        
        print(f"  TTS [{desc}] bar{bar_start}: {text}")
        ok = await gen_tts(text, tmp)
        if not ok:
            print(f"    FAILED, skip")
            continue
        
        sr_in, audio = load_wav(tmp)
        try:
            os.remove(tmp)
        except:
            pass
        
        if len(audio) < 100:
            continue
        
        # 重采样到目标时长
        target_samples = max(1, int(seg_dur * SR))
        from scipy.signal import resample
        audio_rs = resample(audio.astype(np.float64), int(len(audio) * target_samples / len(audio))).astype(np.float32)
        if len(audio_rs) > target_samples:
            audio_rs = audio_rs[:target_samples]
        elif len(audio_rs) < target_samples:
            audio_rs = np.pad(audio_rs, (0, target_samples - len(audio_rs)))
        
        # 按第一个音符变调
        base_semi = midi_to_semitones_from_ref(notes[0])
        pitched = simple_pitch_shift(audio_rs, SR, base_semi)
        
        # 对每个拍微调
        spb = int(beat_dur * SR)  # samples per beat
        for i, note in enumerate(notes):
            s0 = i * spb
            s1 = min(s0 + spb, len(pitched))
            if s1 <= s0:
                continue
            seg_semi = midi_to_semitones_from_ref(note)
            rel_semi = seg_semi - base_semi
            if abs(rel_semi) > 0.1:
                chunk = pitched[s0:s1]
                shifted = simple_pitch_shift(chunk, SR, rel_semi)
                pitched[s0:s0+len(shifted)] = shifted
        
        # 写入轨道
        out_s0 = int(start_time * SR)
        out_s1 = out_s0 + len(pitched)
        out_s1 = min(out_s1, len(vocal_track))
        vocal_track[out_s0:out_s1] += pitched[:out_s1-out_s0]
    
    # 归一化
    maxv = np.abs(vocal_track).max()
    if maxv > 0:
        vocal_track = vocal_track / maxv * 28000.0
    
    # 加简单混响
    delay_ms = 90
    ds = int(delay_ms / 1000 * SR)
    reverb = np.zeros_like(vocal_track)
    reverb[ds:] = vocal_track[:-ds] * 0.25
    vocal_track = vocal_track + reverb
    
    return vocal_track

def mix_and_save(vocal_mono, inst_path, out_wav, out_mp3):
    """混音+保存"""
    # 加载伴奏
    sr_i, inst = load_wav(inst_path)
    if inst.ndim == 1:
        inst = inst.reshape(-1, 1)
    else:
        inst = inst  # already 2D-like
    
    # 对齐
    min_len = min(len(vocal_mono), inst.shape[0] if inst.ndim > 1 else len(inst))
    vocal_mono = vocal_mono[:min_len]
    if inst.ndim == 1:
        inst = inst[:min_len].reshape(-1, 1)
    else:
        inst = inst[:min_len]
    
    # 转立体声
    vocal_st = np.column_stack([vocal_mono, vocal_mono])
    
    # 混音
    mixed = inst.astype(np.float64) * 0.75 + vocal_st.astype(np.float64) * 0.85
    mixed = np.tanh(mixed / 20000.0) * 20000.0
    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 30000.0
    
    save_wav(out_wav, mixed.astype(np.float32))
    print(f"WAV: {out_wav} ({os.path.getsize(out_wav)//1024}KB)")
    
    # MP3
    try:
        import lameenc
        enc = lameenc.Encoder()
        enc.set_bit_rate(192)
        enc.set_in_sample_rate(SR)
        enc.set_channels(2)
        enc.set_quality(2)
        audio_16 = np.clip(mixed, -32768, 32767).astype(np.int16)
        mp3_data = enc.encode(audio_16.tobytes()) + enc.flush()
        with open(out_mp3, 'wb') as f:
            f.write(mp3_data)
        print(f"MP3: {out_mp3} ({os.path.getsize(out_mp3)//1024}KB)")
    except ImportError:
        print("lameenc 不可用，无法生成 MP3")

async def main():
    t0 = time.time()
    print("=" * 50)
    print("大器晚成 - 带人声完整版")
    print("=" * 50)
    
    print("\n[1/3] 合成人声 (edge-tts)...")
    vocal = await synth_all_vocals()
    save_wav("dqwc_vocal_full.wav", vocal)
    print(f"人声: dqwc_vocal_full.wav ({os.path.getsize('dqwc_vocal_full.wav')//1024}KB)")
    
    print("\n[2/3] 混音...")
    mix_and_save(vocal, "daqiwancheng.wav", 
                 "daqiwancheng_with_vocal.wav",
                 "daqiwancheng_with_vocal.mp3")
    
    print(f"\n[3/3] 完成! 耗时 {time.time()-t0:.0f}s")
    print("成品: daqiwancheng_with_vocal.wav / .mp3")

asyncio.run(main())
