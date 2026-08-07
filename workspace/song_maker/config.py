"""
歌曲制作配置文件
"""
import os
from pathlib import Path

# ============================================
# 路径配置
# ============================================
BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

# 模型缓存目录
MODEL_CACHE_DIR = BASE_DIR / "models"
MODEL_CACHE_DIR.mkdir(exist_ok=True)

# ============================================
# HuggingFace 配置
# ============================================
# 国内镜像加速
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HOME"] = str(MODEL_CACHE_DIR / "huggingface")
os.environ["TRANSFORMERS_CACHE"] = str(MODEL_CACHE_DIR / "transformers")

# ============================================
# DiffRhythm 模型配置
# ============================================
DIFFRHYTHM_CONFIG = {
    # 模型路径 (首次运行会自动下载)
    "model_path": "ASLP-lab/DiffRhythm",
    
    # 推理参数
    "num_inference_steps": 50,        # 扩散步数 (越多质量越好，速度越慢)
    "guidance_scale": 7.5,            # CFG 引导强度
    "audio_duration": 30,             # 生成时长 (秒)，最大 285 秒 (4:45)
    "sample_rate": 44100,             # 采样率
    
    # 显存优化
    "enable_cpu_offload": True,       # CPU offload (节省显存)
    "enable_sequential_cpu_offload": False,  # 更激进的 offload (更慢)
    "use_fp16": True,                 # 半精度推理 (节省显存)
}

# ============================================
# 备选: YuE 模型配置 (如需切换)
# ============================================
YUE_CONFIG = {
    "model_path": "multimodal-art-projection/YuE-s1-7B-anneal",
    "quantization": "int4",           # int4 / int8 / none
    "max_new_tokens": 8192,
    "temperature": 0.8,
}

# ============================================
# 作词配置 (调用灵犀引擎 LLM)
# ============================================
LYRICS_CONFIG = {
    "engine_api": "http://localhost:3000",  # 灵犀引擎 API
    "default_style": "流行",
    "default_language": "zh",
}

# ============================================
# MCP Server 配置
# ============================================
MCP_CONFIG = {
    "host": "127.0.0.1",
    "port": 8765,
    "name": "song-maker",
    "version": "1.0.0",
}

# ============================================
# 后处理配置
# ============================================
POST_PROCESS_CONFIG = {
    "normalize": True,                # 音量标准化
    "target_loudness": -14.0,         # 目标响度 (LUFS)
    "fade_in_duration": 0.5,          # 淡入时长 (秒)
    "fade_out_duration": 2.0,         # 淡出时长 (秒)
    "output_format": "wav",           # wav / mp3 / flac
}
