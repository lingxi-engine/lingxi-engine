"""
AI Song Maker - 全局配置
RTX 3060 12GB / 64GB RAM 优化配置
"""
import os
from pathlib import Path

# ============================================================
# 路径配置
# ============================================================
PROJECT_ROOT = Path(__file__).parent
MODELS_DIR = PROJECT_ROOT / "models"
OUTPUT_DIR = PROJECT_ROOT / "output"
TEMP_DIR = PROJECT_ROOT / "temp"

# 确保目录存在
for d in [MODELS_DIR, OUTPUT_DIR, TEMP_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ============================================================
# 模型配置
# ============================================================

# --- 作词 LLM ---
LYRICS_MODEL_ID = "Qwen/Qwen2.5-7B-Instruct"  # 中文歌词生成
LYRICS_MODEL_QUANT = "4bit"  # 4bit量化，显存约5GB
LYRICS_MAX_TOKENS = 1024

# --- 伴奏生成 (MusicGen) ---
MUSICGEN_MODEL_ID = "facebook/musicgen-medium"  # 1.5B参数，显存约5GB
MUSICGEN_DURATION = 30  # 单次生成秒数（最长30s，多次拼接）
MUSICGEN_OVERLAP = 5  # 片段重叠秒数（用于无缝拼接）

# --- 人声合成 (DiffSinger) ---
# DiffSinger 需要 OpenUtau 社区声库
# 推荐中文声库: 星尘、洛天依、乐正绫 等
DIFFSINGER_VOICEBANK_DIR = MODELS_DIR / "diffsinger_voicebanks"
DIFFSINGER_DEFAULT_VOICE = "stardust"  # 默认声库

# --- 降级方案: edge-tts (无歌唱能力，仅朗读) ---
EDGE_TTS_VOICE = "zh-CN-XiaoyiNeural"  # 微软中文女声
EDGE_TTS_RATE = "+0%"

# ============================================================
# 音频配置
# ============================================================
SAMPLE_RATE = 32000  # 采样率
AUDIO_FORMAT = "wav"  # 输出格式
VOCAL_VOLUME_DB = 0  # 人声音量调整 (dB)
ACCOMPANIMENT_VOLUME_DB = -3  # 伴奏音量调整 (dB，略低于人声)

# ============================================================
# 硬件配置
# ============================================================
DEVICE = "cuda"  # cuda / cpu
DTYPE = "float16"  # float16 节省显存
MAX_VRAM_GB = 10  # 预留2GB给系统

# ============================================================
# MCP Server 配置
# ============================================================
MCP_HOST = "0.0.0.0"
MCP_PORT = 8900  # 避免与灵犀引擎冲突

# ============================================================
# 流水线配置
# ============================================================
PIPELINE_STEPS = [
    "generate_lyrics",      # 作词
    "generate_melody",      # 作曲（MIDI旋律）
    "generate_accompaniment",  # 编曲（伴奏）
    "synthesize_vocal",     # 人声合成
    "mix_and_master",       # 混音母带
]
