# -*- coding: utf-8 -*-
import io
path = r"C:\Users\Administrator\lingxi-engine\workspace\music\song.py"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
print("TOTAL LINES:", len(lines))
for i, line in enumerate(lines[120:], start=121):
    print(f"{i:4d}| {line}", end="")
