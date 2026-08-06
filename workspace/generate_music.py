import os
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["PYTHONIOENCODING"] = "utf-8"

import torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration
import soundfile as sf
import time

print("=" * 50)
print("MusicGen Music Generator (hf-mirror)")
print("=" * 50)

# Check GPU
print(f"\nCUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    props = torch.cuda.get_device_properties(0)
    print(f"VRAM: {props.total_mem / 1024**3:.1f} GB")
    device = "cuda"
else:
    print("Using CPU (will be slow)")
    device = "cpu"

# Load model
print("\nLoading model facebook/musicgen-medium from hf-mirror.com...")
print("(First run downloads ~3GB model)")
start = time.time()

processor = AutoProcessor.from_pretrained("facebook/musicgen-medium")
model = MusicgenForConditionalGeneration.from_pretrained(
    "facebook/musicgen-medium",
    torch_dtype=torch.float16 if device == "cuda" else torch.float32,
).to(device)

print(f"Model loaded in {time.time() - start:.1f}s")

# Generate
prompt = "uplifting folk acoustic guitar, warm sunny afternoon, positive vibes, 120bpm"
print(f"\nPrompt: {prompt}")
print("Generating music (30-60s)...")

inputs = processor(
    text=[prompt],
    padding=True,
    return_tensors="pt",
).to(device)

start = time.time()
with torch.no_grad():
    audio_values = model.generate(
        **inputs,
        do_sample=True,
        guidance_scale=3.0,
        max_new_tokens=1500,
    )

print(f"Generated in {time.time() - start:.1f}s")

# Save
output_path = "generated_song.wav"
sampling_rate = model.config.audio_encoder.sampling_rate
audio = audio_values[0].cpu().numpy()
sf.write(output_path, audio, sampling_rate)

print(f"\nSaved: {output_path}")
print(f"Sample rate: {sampling_rate} Hz")
print(f"Duration: {len(audio) / sampling_rate:.1f}s")
print("=" * 50)
