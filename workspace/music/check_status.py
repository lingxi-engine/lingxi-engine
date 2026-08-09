# -*- coding: utf-8 -*-
import os, glob, torch

print("=== GPU ===")
print("CUDA:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("VRAM:", round(torch.cuda.get_device_properties(0).total_memory/1024**3,1), "GB")

print("\n=== DiffRhythm pretrained ===")
pt_dir = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local\pretrained"
if os.path.isdir(pt_dir):
    for f in sorted(glob.glob(pt_dir + "/**/*", recursive=True)):
        if os.path.isfile(f):
            sz = os.path.getsize(f)
            print(f"{sz:>12,}  {f}")
else:
    print("目录不存在:", pt_dir)

print("\n=== workspace/music ===")
music_dir = r"C:\Users\Administrator\lingxi-engine\workspace\music"
for f in sorted(os.listdir(music_dir)):
    fp = os.path.join(music_dir, f)
    if os.path.isfile(fp):
        sz = os.path.getsize(fp)
        print(f"{sz:>12,}  {f}")

print("\n=== diffrhythm-local 顶层 ===")
dr_dir = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local"
if os.path.isdir(dr_dir):
    for f in sorted(os.listdir(dr_dir)):
        print(f"  {f}")