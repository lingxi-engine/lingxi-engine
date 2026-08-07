"""
AI 歌曲制作环境测试脚本
验证所有依赖是否正确安装
"""
import sys
import importlib

def check_module(name, min_version=None):
    """检查模块是否可用"""
    try:
        mod = importlib.import_module(name)
        version = getattr(mod, '__version__', 'unknown')
        print(f"✅ {name}: {version}")
        return True
    except ImportError as e:
        print(f"❌ {name}: 未安装 - {e}")
        return False

def check_gpu():
    """检查 GPU 状态"""
    try:
        import torch
        print(f"\n{'='*50}")
        print("GPU 状态检查")
        print(f"{'='*50}")
        print(f"PyTorch 版本: {torch.__version__}")
        print(f"CUDA 可用: {torch.cuda.is_available()}")
        
        if torch.cuda.is_available():
            print(f"CUDA 版本: {torch.version.cuda}")
            print(f"GPU 名称: {torch.cuda.get_device_name(0)}")
            vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
            print(f"GPU 显存: {vram:.1f} GB")
            
            if vram < 10:
                print(f"⚠️  显存不足 10GB，DiffRhythm 可能无法运行")
            else:
                print(f"✅ 显存充足，可以运行 DiffRhythm")
        else:
            print("⚠️  未检测到 GPU，将使用 CPU（速度极慢）")
        return torch.cuda.is_available()
    except Exception as e:
        print(f"❌ GPU 检查失败: {e}")
        return False

def main():
    print("="*50)
    print("AI 歌曲制作环境检查")
    print("="*50)
    print()
    
    # 检查核心依赖
    print("核心依赖:")
    modules = [
        'torch',
        'torchaudio',
        'transformers',
        'diffusers',
        'accelerate',
        'soundfile',
        'librosa',
        'scipy',
        'numpy',
        'pydub',
        'midiutil',
    ]
    
    results = []
    for mod in modules:
        results.append(check_module(mod))
    
    print()
    
    # 检查 MCP 相关
    print("MCP Server 依赖:")
    mcp_modules = ['fastapi', 'uvicorn']
    for mod in mcp_modules:
        results.append(check_module(mod))
    
    print()
    
    # 检查 GPU
    gpu_ok = check_gpu()
    
    print()
    print("="*50)
    if all(results) and gpu_ok:
        print("✅ 环境检查通过！可以开始生成歌曲")
        print()
        print("下一步: python generate_song.py")
    else:
        print("❌ 环境检查未通过，请重新运行 install_song_env.bat")
    print("="*50)

if __name__ == "__main__":
    main()
