# -*- coding: utf-8 -*-
"""大器晚成 - 人声生成+混音 完整版

使用 edge-tts 合成中文语音 → 按旋律音高变调 → 混入伴奏 → 输出成品
全程本地执行，10 分钟内完成
"""
import asyncio, subprocess, sys, os, wave, struct, math, time
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

os.chdir(r"C:\Users\Administrator\lingxi-engine\workspace\music")

SR = 44100
BPM = 80
SEC_PER_BAR = 60.0 / BPM * 4  # 3.0s per bar

# ============ 歌词（按小节分段，对应伴奏结构） ============
# 伴奏结构：前奏(4) 主歌1(8) 预副歌(4) 副歌1(8) 间奏(4) 主歌2(8) 预副歌2(4) 副歌2(8) 桥段(8) Solo(8) 副歌3(8) 尾奏(8) = 80bars
# 只给有声段落配歌词

lyrics_segments = [
    # (开始小节, 文本, 旋律音高列表 [每拍一个音], 声部描述)
    # 主歌1: bars 4-12
    (4, "曾经多少次跌倒在地上，",    [62,62,65,66,69,69,69,69,67,67,67], "低音诉说"),
    (6, "曾经多少次迷失了方向，",    [62,62,65,66,69,69,69,69,67,65,65], "低音诉说"),
    (7, "每一次黑夜都那么漫长，",    [64,64,67,69,71,71,71,71,69,69,69], "微微上扬"),
    (8, "心中那团火却从未熄灭过，",  [66,66,69,71,73,73,73,73,71,69,66], "蓄力"),
    
    # 预副歌: bars 12-16
    (12, "我知道，我知道，",         [69,69,71,71,73,73,73], "渐强"),
    (13, "风雨过后一定有彩虹，",     [71,71,73,74,76,76,76,74,73], "扬起"),
    (14, "我相信，我相信，",         [69,69,71,71,73,73,73], "坚定"),
    (15, "总有一天会站上巅峰，",     [71,71,73,74,76,76,76,74,73,71], "高昂"),
    
    # 副歌1: bars 16-24
    (16, "大器晚成 我不怕等，",      [74,74,74,76,76,76,78,78,78], "爆发"),
    (17, "每一步都是青春的见证，",    [76,76,76,78,78,78,79,79,79], "高亢"),
    (18, "大器晚成 热血在沸腾，",    [74,74,74,76,76,76,78,78,78], "爆发"),
    (19, "这一生我绝不再退缩，",      [76,76,76,78,78,78,79,79,79,78], "坚定"),
    (20, "大器晚成 我不怕等，",      [74,74,74,76,76,76,78,78,78], "爆发"),
    (21, "哪怕一路上多少伤痕，",      [76,76,76,78,78,78,79,79,79], "高亢"),
    (22, "大器晚成 冲破这围城，",    [74,74,74,76,76,76,78,78,78], "爆发"),
    (23, "总有一天会让世界沸腾，",    [76,76,76,78,78,78,79,79,79,78,76], "最强音"),
    
    # 主歌2: bars 28-36
    (28, "曾经多少次对自己失望，",    [62,62,65,66,69,69,69,69,67,67,67], "低音诉说"),
    (30, "曾经多少次想要去放弃，",    [62,62,65,66,69,69,69,69,67,65,65], "低音诉说"),
    (31, "但每次想起最初的梦想，",    [64,64,67,69,71,71,71,71,69,69,69], "微微上扬"),
    (32, "就咬着牙告诉自己不能再逃，", [66,66,69,71,73,73,73,73,71,69,66,66], "蓄力"),
    
    # 预副歌2: bars 36-40
    (36, "我知道，我知道，",         [69,69,71,71,73,73,73], "渐强"),
    (37, "风雨过后一定有彩虹，",     [71,71,73,74,76,76,76,74,73], "扬起"),
    (38, "我相信，我相信，",         [69,69,71,71,73,73,73], "坚定"),
    (39, "这一次我绝不再放手，",     [71,71,73,74,76,76,76,74,73,71], "高昂"),
    
    # 副歌2: bars 40-48
    (40, "大器晚成 我不怕等，",      [74,74,74,76,76,76,78,78,78], "爆发"),
    (41, "每一步都是青春的见证，",    [76,76,76,78,78,78,79,79,79], "高亢"),
    (42, "大器晚成 热血在沸腾，",    [74,74,74,76,76,76,78,78,78], "爆发"),
    (43, "这一生我绝不再退缩，",      [76,76,76,78,78,78,79,79,79,78], "坚定"),
    (44, "大器晚成 我不怕等，",      [74,74,74,76,76,76,78,78,78], "爆发"),
    (45, "哪怕一路上多少伤痕，",      [76,76,76,78,78,78,79,79,79], "高亢"),
    (46, "大器晚成 冲破这围城，",    [74,74,74,76,76,76,78,78,78], "爆发"),
    (47, "总有一天会让世界沸腾，",    [76,76,76,78,78,78,79,79,79,78,76], "最强音"),
    
    # 桥段: bars 48-56 (低沉、情感)
    (48, "也许 还要走很长的路，",     [66,66,66,66,69,69,67,67], "低沉"),
    (50, "也许 还有无数个孤独，",     [66,66,66,66,69,69,67,67], "低沉"),
    (52, "但我早已不怕等待，",        [67,67,69,69,71,71,71,71], "渐起"),
    (54, "因为我相信大器晚成，",      [69,69,71,71,73,73,73,73,73], "升起"),
    
    # 副歌3 (升调): bars 64-72 [E大调]
    (64, "大器晚成 我不怕等，",      [76,76,76,78,78,78,80,80,80], "最高爆发"),
    (65, "每一步都是青春的见证，",    [78,78,78,80,80,80,81,81,81], "最高"),
    (66, "大器晚成 热血在沸腾，",    [76,76,76,78,78,78,80,80,80], "最高爆发"),
    (67, "这一生我绝不再退缩，",      [78,78,78,80,80,80,81,81,81,80], "最高"),
    (68, "大器晚成 我不怕等，",      [76,76,76,78,78,78,80,80,80], "最高爆发"),
    (69, "哪怕一路上多少伤痕，",      [78,78,78,80,80,80,81,81,81], "最高"),
    (70, "大器晚成 冲破这围城，",    [76,76,76,78,78,78,80,80,80], "最高爆发"),
    (71, "这一天终于让世界沸腾，",    [78,78,78,80,80,80,81,81,81,80,78], "最终爆发"),
]

async def gen_tts(text, out_wav, voice="zh-CN-YunxiNeural", rate="+0%"):
    """用 edge-tts 生成语音 WAV"""
    cmd = [
        "edge-tts",
        "--voice", voice,
        "--text", text,
        "--write-media", out_wav,
        "--rate", rate,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        print(f"TTS 失败: {stderr.decode()}")
        return False
    return True

def load_wav(path):
    """加载 WAV，返回 (sr, data)"""
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    dtype = np.int16 if ch == 1 or True else np.int16
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if ch > 1:
        data = data.reshape(-1, ch)
    return sr, data

def save_wav(path, data, sr=SR):
    """保存 WAV，data 可以是 1D 或 2D"""
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    data = np.clip(data, -32768, 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(data.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data.tobytes())

def pitch_shift_psola(data, sr, semitones):
    """简单的半音变调：重采样+速度修正"""
    if abs(semitones) < 0.01:
        return data
    factor = 2.0 ** (semitones / 12.0)
    # 变调：先变采样率再插值回原速
    new_len = int(len(data) / factor)
    if new_len < 1:
        return data
    stretched = resample_poly(data.astype(np.float64), len(data), new_len)
    # 插值回原长度
    result = resample_poly(stretched, new_len, len(data))
    return result.astype(np.float32)

def midi_to_freq(midi_note):
    return 440.0 * (2.0 ** ((midi_note - 69) / 12.0))

def synth_singing(lyrics, notes, total_duration_sec, sr=SR):
    """把 TTS 语音按旋律音高变调混音
    
    策略：对于每个歌词片段，生成 TTS → 切成每拍 → 变调到对应音高 → 拼接
    """
    output = np.zeros(int(total_duration_sec * sr), dtype=np.float32)
    
    beat_dur = 60.0 / BPM  # 每拍秒数
    
    for bar_start, text, note_list, desc in lyrics:
        bar_start_time = bar_start * SEC_PER_BAR
        text_dur = len(note_list) * beat_dur
        
        # 生成这行歌词的 TTS
        tmp = f"tmp_vocal_{bar_start}.wav"
        print(f"  [{desc}] bar {bar_start}: {text}")
        
        try:
            asyncio.run(gen_tts(text, tmp, rate="-10%"))
        except Exception as e:
            print(f"    TTS 失败: {e}")
            continue
        
        if not os.path.exists(tmp):
            continue
        
        sr_in, audio = load_wav(tmp)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)  # 转单声道
        
        # 简单处理：把整段语音拉伸/压缩到目标时长，然后整体变调
        target_samples = int(text_dur * sr)
        if len(audio) > 0 and target_samples > 0:
            # 时域拉伸到目标长度
            audio_resized = resample_poly(audio.astype(np.float64), len(audio), target_samples).astype(np.float32)
            
            # 整体按第一个音符变调
            base_note = note_list[0]
            base_freq = midi_to_freq(base_note)
            # 估算原始语音的平均音高（男声~120Hz，女声~200Hz，Yunxi 男声约 150Hz）
            orig_pitch_hz = 150.0
            semitones = 12.0 * math.log2(base_freq / orig_pitch_hz)
            
            pitched = pitch_shift_psola(audio_resized, sr, semitones)
            
            # 对每个拍再微调音高
            samples_per_beat = int(beat_dur * sr)
            for i, note in enumerate(note_list):
                start_sample = i * samples_per_beat
                end_sample = min(start_sample + samples_per_beat, len(pitched))
                if end_sample <= start_sample:
                    continue
                chunk = pitched[start_sample:end_sample].copy()
                # 微调
                chunk_semitones = 12.0 * math.log2(midi_to_freq(note) / base_freq)
                if abs(chunk_semitones) > 0.1:
                    chunk_shifted = pitch_shift_psola(chunk, sr, chunk_semitones)
                    pitched[start_sample:start_sample + len(chunk_shifted)] = chunk_shifted
            
            # 写入输出
            out_start = int(bar_start_time * sr)
            out_end = out_start + min(len(pitched), int(text_dur * sr))
            out_end = min(out_end, len(output))
            out_len = out_end - out_start
            if out_len > 0:
                output[out_start:out_start+out_len] += pitched[:out_len]
        
        # 清理
        try:
            os.remove(tmp)
        except:
            pass
    
    # 归一化
    maxv = np.abs(output).max()
    if maxv > 0:
        output = output / maxv * 0.9
    
    return output

def mix_with_instrumental(vocal, inst_path, out_path, vocal_gain=0.7, inst_gain=0.8):
    """把人声混入伴奏"""
    sr_inst, inst = load_wav(inst_path)
    if inst.ndim == 1:
        inst = inst.reshape(-1, 1)
    
    # 对齐长度
    min_len = min(len(vocal), inst.shape[0])
    vocal = vocal[:min_len]
    inst = inst[:min_len]
    
    # 人声转立体声
    vocal_stereo = np.column_stack([vocal, vocal])
    
    # 给人声加一点混响（简单延迟）
    delay_ms = 80
    delay_samples = int(delay_ms / 1000 * SR)
    reverb_vocal = np.zeros_like(vocal_stereo)
    reverb_vocal[delay_samples:] = vocal_stereo[:-delay_samples] * 0.3
    vocal_wet = vocal_stereo + reverb_vocal
    
    # 混音
    mixed = inst.astype(np.float64) * inst_gain + vocal_wet.astype(np.float64) * vocal_gain
    
    # 软削波
    mixed = np.tanh(mixed / 20000.0) * 20000.0
    
    # 最终归一化
    peak = np.abs(mixed).max()
    if peak > 0:
        mixed = mixed / peak * 30000.0
    
    save_wav(out_path, mixed.astype(np.float32), SR)
    print(f"混音完成: {out_path}")
    return mixed

if __name__ == "__main__":
    t0 = time.time()
    print("=" * 50)
    print("大器晚成 - 人声生成")
    print("=" * 50)
    
    # 计算总时长
    total_bars = 80
    total_sec = total_bars * SEC_PER_BAR
    print(f"总时长: {total_sec:.0f}秒 / {total_bars} 小节 / BPM {BPM}")
    
    # Step 1: 生成所有 TTS 并变调
    print("\n[Step 1] 合成人声...")
    vocal = synth_singing(lyrics_segments, [], total_sec)  # notes are embedded in lyrics_segments
    
    # 保存纯人声
    vocal_path = "dqwc_vocal_full.wav"
    vocal_mono = vocal  # already mono
    save_wav(vocal_path, vocal_mono, SR)
    print(f"人声保存: {vocal_path} ({os.path.getsize(vocal_path)/1024:.0f}KB)")
    
    # Step 2: 混入伴奏
    print("\n[Step 2] 混音...")
    inst_path = "daqiwancheng.wav"
    if not os.path.exists(inst_path):
        inst_path = "daqiwancheng_inst.wav"
    
    if os.path.exists(inst_path):
        out_path = "daqiwancheng_vocal.wav"
        mix_with_instrumental(vocal, inst_path, out_path, vocal_gain=0.8, inst_gain=0.7)
    else:
        print(f"未找到伴奏文件: {inst_path}")
        # 人声本身就是成品
        out_path = vocal_path
    
    # Step 3: 编码 MP3
    print("\n[Step 3] 编码 MP3...")
    try:
        import lameenc
        encoder = lameenc.Encoder()
        encoder.set_bit_rate(192)
        encoder.set_in_sample_rate(SR)
        encoder.set_channels(2)
        encoder.set_quality(2)
        
        sr_in, audio_in = load_wav(out_path)
        if audio_in.ndim == 1:
            audio_in = np.column_stack([audio_in, audio_in])
        audio_in = np.clip(audio_in, -32768, 32767).astype(np.int16)
        
        mp3_data = encoder.encode(audio_in.tobytes())
        mp3_data += encoder.flush()
        
        mp3_path = "daqiwancheng_vocal.mp3"
        with open(mp3_path, 'wb') as f:
            f.write(mp3_data)
        print(f"MP3 编码完成: {mp3_path} ({os.path.getsize(mp3_path)/1024:.0f}KB)")
    except ImportError:
        print("lameenc 不可用，跳过 MP3")
    
    print(f"\n总耗时: {time.time()-t0:.0f}秒")
    print("DONE")
