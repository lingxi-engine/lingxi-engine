# 音乐生成脚本
import os
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'

from audiocraft.models import MusicGen
from audiocraft.data.audio import audio_write
import torch
import sys

def check_gpu():
    """检查 GPU 状态"""
    print("=" * 50)
    print("系统检查")
    print("=" * 50)
    print(f"PyTorch 版本: {torch.__version__}")
    print(f"CUDA 可用: {torch.cuda.is_available()}")
    
    if torch.cuda.is_available():
        print(f"CUDA 版本: {torch.version.cuda}")
        print(f"GPU 名称: {torch.cuda.get_device_name(0)}")
        print(f"GPU 显存: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")
    else:
        print("⚠️  未检测到 GPU，将使用 CPU（速度较慢）")
    print()

def generate_music(description="温暖的民谣吉他，缓慢节奏，阳光午后氛围", duration=60, model_name='medium'):
    """
    生成音乐
    
    参数:
        description: 音乐描述（中文或英文）
        duration: 时长（秒）
        model_name: 模型名称 ('small', 'medium', 'large')
    """
    print("=" * 50)
    print(f"开始生成音乐")
    print("=" * 50)
    print(f"描述: {description}")
    print(f"时长: {duration} 秒")
    print(f"模型: {model_name}")
    print()
    
    # 加载模型
    print(f"[1/3] 加载模型 {model_name}...")
    print("（首次运行需要下载模型，请耐心等待）")
    model = MusicGen.get_pretrained(model_name)
    print("✅ 模型加载完成")
    print()
    
    # 设置生成参数
    print("[2/3] 设置生成参数...")
    model.set_generation_params(
        duration=duration,
        temperature=0.8,
        top_k=250,
    )
    print("✅ 参数设置完成")
    print()
    
    # 生成音乐
    print("[3/3] 生成音乐中...")
    print("（这可能需要几分钟，取决于你的硬件）")
    wav = model.generate([description])
    print("✅ 生成完成")
    print()
    
    # 保存文件
    output_file = 'generated_song'
    print(f"保存文件: {output_file}.wav")
    audio_write(output_file, wav[0].cpu(), model.sample_rate, strategy='loudness')
    print()
    
    print("=" * 50)
    print("🎉 生成成功！")
    print(f"📁 文件位置: {os.path.abspath(output_file + '.wav')}")
    print("=" * 50)

if __name__ == "__main__":
    check_gpu()
    
    # 从命令行参数获取描述，或使用默认值
    if len(sys.argv) > 1:
        description = ' '.join(sys.argv[1:])
    else:
        description = "温暖的民谣吉他，缓慢节奏，阳光午后氛围"
    
    generate_music(
        description=description,
        duration=60,
        model_name='medium'
    )
