# -*- coding: utf-8 -*-
"""DiffRhythm 推理脚本 - 生成《大器晚成》带人声完整歌曲"""
import os
import sys
import time

os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
sys.path.insert(0, os.getcwd())
sys.path.insert(0, os.path.join(os.getcwd(), "infer"))

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

import torch
import torchaudio

print("=" * 60)
print("DiffRhythm Inference - daqiwancheng")
print("=" * 60)

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Device: {device}")
if device == "cuda":
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

audio_length = 285
max_frames = 6144

print(f"\nTarget duration: {audio_length}s (~{audio_length//60}m{audio_length%60}s)")
print(f"max_frames: {max_frames}")

print("\n[1/4] Loading models...")
t0 = time.time()

# 直接从 infer 目录导入（不是包）
from infer_utils import (
    prepare_model,
    get_lrc_token,
    get_style_prompt,
    get_negative_style_prompt,
    get_reference_latent,
    decode_audio,
)
from infer import inference

cfm, tokenizer, muq, vae = prepare_model(max_frames, device)
print(f"Models loaded in {time.time()-t0:.1f}s")

print("\n[2/4] Processing lyrics...")
lrc_path = os.path.join(os.getcwd(), "infer", "example", "daqiwancheng.lrc")
with open(lrc_path, "r", encoding="utf-8") as f:
    lrc = f.read()
print(f"Lyrics loaded: {len(lrc)} chars")

lrc_prompt, start_time, end_frame, song_duration = get_lrc_token(
    max_frames, lrc, tokenizer, audio_length, device
)
print(f"Lyrics tokenized, end_frame={end_frame}")

print("\n[3/4] Generating style prompt...")
style_prompt = get_style_prompt(
    muq,
    prompt="Pop, Rock, Emotional, Uplifting, Hopeful, Piano, Electric Guitar, Drums, Bass, Strings, Passionate, Cinematic, Epic"
)
print(f"Style vector: {style_prompt.shape}")

negative_style_prompt = get_negative_style_prompt(device)

latent_prompt, pred_frames = get_reference_latent(device, max_frames, False, None, None, vae)

print("\n[4/4] AI generation started (this is the slowest step)...")
print("Estimated 2-8 minutes, please wait...")

t1 = time.time()
generated_songs = inference(
    cfm_model=cfm,
    vae_model=vae,
    cond=latent_prompt,
    text=lrc_prompt,
    duration=end_frame,
    style_prompt=style_prompt,
    negative_style_prompt=negative_style_prompt,
    start_time=start_time,
    pred_frames=pred_frames,
    batch_infer_num=1,
    song_duration=song_duration,
    chunked=True,
)
print(f"\nGeneration done! Time: {time.time()-t1:.1f}s")

import random
generated_song = random.sample(generated_songs, 1)[0]

output_dir = os.path.join(os.getcwd(), "infer", "example", "output")
os.makedirs(output_dir, exist_ok=True)

output_path = os.path.join(output_dir, "daqiwancheng.wav")
torchaudio.save(output_path, generated_song, sample_rate=44100)
print(f"\nOutput: {output_path}")

fsize = os.path.getsize(output_path)
duration_sec = generated_song.shape[-1] / 44100
print(f"File size: {fsize / 1024 / 1024:.1f} MB")
print(f"Duration: {duration_sec:.1f}s ({duration_sec//60:.0f}m{duration_sec%60:.0f}s)")
print(f"Shape: {generated_song.shape}")

import shutil
desktop_path = r"C:\Users\Administrator\Desktop\daqiwancheng_vocal.wav"
shutil.copy2(output_path, desktop_path)
print(f"\nCopied to desktop: {desktop_path}")

print("\n" + "=" * 60)
print("DONE!")
print("=" * 60)