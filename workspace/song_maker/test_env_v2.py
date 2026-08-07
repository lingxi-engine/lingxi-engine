"""
歌曲制作环境测试脚本 v2
检查所有依赖和模型可用性
"""
import sys
import os
import importlib

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'

def check_module(name, pip_name=None):
    """检查模块是否可用"""
    try:
        mod = importlib.import_module(name)
        version = getattr(mod, '__version__', 'N/A')
        print(f"  ✅ {name} ({version})")
        return True
    except ImportError:
        print(f"  ❌ {name} - 未安装 (pip install {pip_name or name})")
        return False


def main():
    print("=" * 60)
    print("🔍 AI 歌曲制作 - 环境检测")
    print("=" * 60)
    print()

    # 1. Python 版本
    print(f"📌 Python: {sys.version}")
    print()

    # 2. PyTorch + CUDA
    print("🔥 PyTorch & CUDA:")
    if check_module('torch'):
        import torch
        print(f"     CUDA 可用: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"     GPU: {torch.cuda.get_device_name(0)}")
            vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
            print(f"     显存: {vram:.1f} GB")
            print(f"     CUDA 版本: {torch.version.cuda}")
        else:
            print("     ⚠️ CUDA 不可用，将使用 CPU（速度极慢）")
    print()

    # 3. 核心依赖
    print("📦 核心依赖:")
    core_deps = [
        ('diffusers', 'diffusers'),
        ('transformers', 'transformers'),
        ('accelerate', 'accelerate'),
        ('safetensors', 'safetensors'),
    ]
    core_ok = all(check_module(name, pip) for name, pip in core_deps)
    print()

    # 4. 音频处理
    print("🎵 音频处理:")
    audio_deps = [
        ('soundfile', 'soundfile'),
        ('librosa', 'librosa'),
        ('scipy', 'scipy'),
        ('pydub', 'pydub'),
    ]
    audio_ok = all(check_module(name, pip) for name, pip in audio_deps)
    print()

    # 5. 中文处理
    print("🈶 中文处理:")
    cn_deps = [
        ('jieba', 'jieba'),
        ('pypinyin', 'pypinyin'),
    ]
    cn_ok = all(check_module(name, pip) for name, pip in cn_deps)
    print()

    # 6. MCP Server
    print("🔌 MCP Server:")
    mcp_deps = [
        ('mcp', 'mcp[cli]'),
        ('fastapi', 'fastapi'),
        ('uvicorn', 'uvicorn'),
        ('httpx', 'httpx'),
        ('pydantic', 'pydantic'),
    ]
    mcp_ok = all(check_module(name, pip) for name, pip in mcp_deps)
    print()

    # 7. 模型仓库检查
    print("📂 模型仓库:")
    from pathlib import Path
    base = Path(__file__).parent

    repos = {
        'DiffRhythm': base / 'DiffRhythm',
        'YuE': base / 'YuE',
    }
    for name, path in repos.items():
        if path.exists():
            print(f"  ✅ {name} ({path})")
        else:
            print(f"  ❌ {name} - 未克隆 (git clone ...)")
    print()

    # 8. 显存评估
    print("💾 显存评估:")
    if torch.cuda.is_available():
        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"  当前显存: {vram:.1f} GB")
        print()
        print("  模型显存需求:")
        print(f"  {'模型':<20} {'显存':<12} {'适合你的GPU':<10}")
        print(f"  {'-'*42}")
        models = [
            ("DiffRhythm", "8-10 GB", "✅ 适合" if vram >= 8 else "❌ 不足"),
            ("YuE (INT4)", "10-12 GB", "✅ 适合" if vram >= 10 else "⚠️ 紧张"),
            ("YuE (FP16)", "14-16 GB", "❌ 不足" if vram < 16 else "✅ 适合"),
            ("MusicGen-small", "3-4 GB", "✅ 适合"),
            ("MusicGen-medium", "6-8 GB", "✅ 适合" if vram >= 6 else "❌ 不足"),
            ("DiffSinger", "4-8 GB", "✅ 适合"),
        ]
        for name, vram_req, fit in models:
            print(f"  {name:<20} {vram_req:<12} {fit}")
    print()

    # 总结
    print("=" * 60)
    all_ok = core_ok and audio_ok and cn_ok
    if all_ok:
        print("✅ 核心环境就绪，可以开始生成歌曲！")
        print()
        print("下一步:")
        print("  1. 克隆模型仓库 (如果还没有)")
        print("  2. 运行: python generate_song_v2.py")
        print("  3. 启动 MCP: python mcp_server_v2.py")
    else:
        print("❌ 环境不完整，请运行 install_v2.bat 安装缺失依赖")
    print("=" * 60)


if __name__ == "__main__":
    main()
