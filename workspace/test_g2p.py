# -*- coding: utf-8 -*-
"""验证 DiffRhythm G2P 链路：espeak -> phonemizer -> chn_eng_g2p"""
import os, sys

ESPEAK_DIR = r"C:\Program Files\eSpeak NG"
os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = os.path.join(ESPEAK_DIR, "libespeak-ng.dll")
os.environ["PHONEMIZER_ESPEAK_PATH"] = ESPEAK_DIR
os.environ["PATH"] = ESPEAK_DIR + os.pathsep + os.environ.get("PATH", "")

ROOT = r"C:\Users\Administrator\lingxi-engine\diffrhythm-local"
os.chdir(ROOT)
sys.path.insert(0, ROOT)

print("cwd:", os.getcwd())

# 测试 phonemizer 直接 phonemize 中文
print("\n=== phonemizer 中文 ===")
try:
    from phonemizer.backend import EspeakBackend
    b = EspeakBackend("cmn", preserve_punctuation=False, with_stress=False, language_switch="remove-flags")
    out = b.phonemize(["你好世界，这是一首中文歌"], strip=True)
    print("[OK]", out)
except Exception as e:
    print(f"[FAIL] {type(e).__name__}: {e}")

# 测试 DiffRhythm 的 G2P 模块（会触发导入 g2p.utils.g2p 里的 backend 初始化）
print("\n=== chn_eng_g2p ===")
try:
    from g2p.g2p_generation import chn_eng_g2p
    phone, token = chn_eng_g2p("你好世界，这是一首中文歌 hello")
    print("[OK] phone:", phone[:120])
    print("[OK] token:", token[:30])
except Exception as e:
    import traceback; traceback.print_exc()

# 测试 CNENTokenizer
print("\n=== CNENTokenizer ===")
try:
    sys.path.insert(0, os.path.join(ROOT, "infer"))
    from infer_utils import CNENTokenizer
    tk = CNENTokenizer()
    t = tk.encode("你好世界")
    print("[OK] encode:", t[:40])
    d = tk.decode(t)
    print("[OK] decode:", d)
except Exception as e:
    import traceback; traceback.print_exc()
