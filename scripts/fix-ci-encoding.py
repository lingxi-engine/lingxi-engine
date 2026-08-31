# -*- coding: utf-8 -*-
"""修复 ci.yml 的编码事故：GBK 误编码内容 -> 标准无 BOM UTF-8"""
import yaml
import sys

PATH = '.github/workflows/ci.yml'
raw = open(PATH, 'rb').read()

# 已是合法 UTF-8 则跳过
try:
    text = raw.decode('utf-8')
    print('SKIP: already valid UTF-8')
    sys.exit(0)
except UnicodeDecodeError:
    pass

# 按 GBK 还原为可读文本（PowerShell 5.1 之前把 UTF-8 内容按 GBK 重编码了）
text = raw.decode('gbk')

# 校验还原后的内容能被 YAML 解析（GitHub Actions 的格式要求）
data = yaml.safe_load(text)
assert isinstance(data, dict) and 'jobs' in data, 'YAML 结构异常'
print('YAML OK, jobs:', list(data['jobs'].keys()))

# 以标准无 BOM UTF-8 写回
with open(PATH, 'wb') as f:
    f.write(text.encode('utf-8'))

# 终验
b = open(PATH, 'rb').read()
assert b[:3] != b'\xef\xbb\xbf', 'BOM 不应存在'
t = b.decode('utf-8')
d = yaml.safe_load(t)
print('FINAL: valid UTF-8, no BOM, jobs =', list(d['jobs'].keys()))