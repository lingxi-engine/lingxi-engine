# -*- coding: utf-8 -*-
"""DiffRhythm 95秒短版推理 - 验证整条链路"""
import os, sys, time, random, shutil

os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join(os.getcwd(), "infer"))
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
import torchaudio

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Device: {device}")

# 95秒版本用 base 模型 (max_frames=2048)
audio_length = 95
max_frames = 2048

print(f"\n[1/4] Loading models (95s version, base model)...")
t0 = time.time()

from infer_utils import (
    prepare_model, get_lrc_token, get_style_prompt,
    get_negative_style_prompt, get_reference_latent, decode_audio,
)
from infer import inference

cfm, tokenizer, muq, vae = prepare_model(max_frames, device)
print(f"Models loaded in {time.time()-t0:.1f}s")
print(f"VRAM used: {torch.cuda.memory_allocated()/1024**3:.1f} GB" if device=="cuda" else "")

# 写一个95秒版本的歌词（截取前面部分）
lrc_95 = """[00:00.00]大器晚成
[00:04.00]作词 AI作曲 AI
[00:08.00]
[00:12.00]少年时我曾以为
[00:16.00]天才会被世界看见
[00:20.00]可岁月像一把钝刀
[00:24.00]慢慢磨去了我的骄傲
[00:28.00]
[00:32.00]有人说你太晚了
[00:36.00]有人说你该放弃了
[00:40.00]可我心里有一团火
[00:44.00]烧了这么多年从未熄过
[00:48.00]
[00:52.00]大器晚成 又何妨
[00:56.00]厚积薄发 终有光
[01:00.00]那些沉默的日子
[01:04.00]都是在积蓄力量
[01:08.00]
[01:12.00]大器晚成 不慌张
[01:16.00]千锤百炼 才成钢
[01:20.00]当世界终于听见我
[01:24.00]才知道等待不算长
[01:28.00]
[01:32.00]大器晚成
[01:40.00]终会到
[01:48.00]
"""

lrc_path = os.path.join(os.getcwd(), "infer", "example", "daqiwancheng_95.lrc")
with open(lrc_path, "w", encoding="utf-8") as f:
    f.write(lrc_95)

print(f"\n[2/4] Processing lyrics...")
lrc_prompt, start_time, end_frame, song_duration = get_lrc_token(
    max_frames, lrc_95, tokenizer, audio_length, device
)
print(f"Lyrics tokenized, end_frame={end_frame}")

print(f"\n[3/4] Generating style prompt...")
style_prompt = get_style_prompt(
    muq,
    prompt="Pop, Rock, Emotional, Uplifting, Hopeful, Piano, Electric Guitar, Drums, Bass, Strings, Passionate, Cinematic, Epic, Male Vocal"
)
print(f"Style vector: {style_prompt.shape}")

negative_style_prompt = get_negative_style_prompt(device)
latent_prompt, pred_frames = get_reference_latent(device, max_frames, False, None, None, vae)

print(f"\n[4/4] AI generation started...")
t1 = time.time()
generated_songs = inference(
    cfm_model=cfm, vae_model=vae,
    cond=latent_prompt, text=lrc_prompt,
    duration=end_frame, style_prompt=style_prompt,
    negative_style_prompt=negative_style_prompt,
    start_time=start_time, pred_frames=pred_frames,
    batch_infer_num=1, song_duration=song_duration, chunked=True,
)
print(f"Generation done! Time: {time.time()-t1:.1f}s")

generated_song = random.sample(generated_songs, 1)[0]

output_dir = os.path.join(os.getcwd(), "infer", "example", "output")
os.makedirs(output_dir, exist_ok=True)
output_path = os.path.join(output_dir, "daqiwancheng_vocal_95.wav")
torchaudio.save(output_path, generated_song, sample_rate=44100)

fsize = os.path.getsize(output_path)
duration_sec = generated_song.shape[-1] / 44100
print(f"\nOutput: {output_path}")
print(f"File size: {fsize/1024/1024:.1f} MB")
print(f"Duration: {duration_sec:.1f}s")
print(f"Shape: {generated_song.shape}")

# Copy to desktop
desktop_path = r"C:\Users\Administrator\Desktop\daqiwancheng_vocal_95.wav"
shutil.copy2(output_path, desktop_path)
print(f"Copied to desktop: {desktop_path}")
print("\nDONE!")