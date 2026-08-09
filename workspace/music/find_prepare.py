# -*- coding: utf-8 -*-
"""查找 prepare_model 和 muq 加载逻辑"""
import re

path = r'C:\Users\Administrator\lingxi-engine\diffrhythm-local\infer\infer_utils.py'
with open(path, 'r', encoding='utf-8') as f:
    src = f.read()

# 找到 prepare_model 函数
idx = src.find('def prepare_model')
print("=== prepare_model 位置:", idx)
if idx > 0:
    print(src[idx:idx+3000])
