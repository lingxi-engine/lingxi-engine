# -*- coding: utf-8 -*-
"""验证 phonemizer 中文后端是否可用"""
import os, sys

ESPEAK_DIR = r"C:\Program Files\eSpeak NG"

# 方式1: 设置 phonemizer 专用环境变量（Windows 推荐，直接加载 dll）
os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = os.path.join(ESPEAK_DIR, "libespeak-ng.dll")
os.environ["PHONEMIZER_ESPEAK_PATH"] = ESPEAK_DIR
# 方式2: 同时加入 PATH
os.environ["PATH"] = ESPEAK_DIR + os.pathsep + os.environ.get("PATH", "")

print("=== 测试 1: EspeakBackend 中文初始化 ===")
try:
    from phonemizer.backend import EspeakBackend
    backend = EspeakBackend("cmn", language_switch="remove_blank")
    print("[OK] EspeakBackend('cmn') 初始化成功")
except Exception as e:
    print(f"[FAIL] {type(e).__name__}: {e}")

print("\n=== 测试 2: 中文 phonemize ===")
try:
    from phonemizer.backend import EspeakBackend
    backend = EspeakBackend("cmn", language_switch="remove_blank")
    out = backend.phonemize(["你好世界，这是一首中文歌。"])
    print(f"[OK] 输出: {out}")
except Exception as e:
    print(f"[FAIL] {type(e).__name__}: {e}")

print("\n=== 测试 3: espeak-ng 命令行 ===")
try:
    r = os.system('"C:\\Program Files\\eSpeak NG\\espeak-ng.exe" --version')
    print(f"[OK] exit={r}")
except Exception as e:
    print(f"[FAIL] {e}")

print("\n=== 测试 4: phonemizer 后端枚举 ===")
try:
    from phonemizer.backend import EspeakBackend
    langs = EspeakBackend.supported_languages()
    has_cmn = "cmn" in langs or "cmn-CN" in langs or "zh" in langs
    print(f"支持语言数: {len(langs)} | 含中文: {has_cmn}")
    zh = [l for l in langs if "cmn" in l or "zh" in l or "yue" in l]
    print("中文相关:", zh[:10])
except Exception as e:
    print(f"[FAIL] {type(e).__name__}: {e}")
