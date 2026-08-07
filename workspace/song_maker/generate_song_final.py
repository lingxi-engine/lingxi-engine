"""
AI 歌曲生成器 - 最终可用版本
基于 Meta MusicGen，自包含，无需额外 git clone
支持：文本描述 → 生成音乐（伴奏/纯音乐）
适配 RTX 3060 12GB 显存
"""
import os
import sys
import time
import json
import argparse
import logging
from pathlib import Path

# 设置 HuggingFace 镜像（国内加速）
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger('song_generator')

SCRIPT_DIR = Path(__file__).parent
OUTPUT_DIR = SCRIPT_DIR / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)


def check_gpu():
    """检查 GPU 可用性"""
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            gpu_mem = torch.cuda.get_device_properties(0).total_mem / 1024**3
            logger.info(f"✅ GPU: {gpu_name}, 显存: {gpu_mem:.1f}GB")
            return 'cuda'
        else:
            logger.warning("⚠️ CUDA 不可用，将使用 CPU（会很慢）")
            return 'cpu'
    except Exception as e:
        logger.warning(f"⚠️ GPU 检查失败: {e}，使用 CPU")
        return 'cpu'


def generate_musicgen(description, duration=15, output_path=None, device='cuda'):
    """
    使用 MusicGen 生成音乐
    
    Args:
        description: 音乐描述（英文效果更好）
        duration: 生成时长（秒），MusicGen-small 最大约 30 秒
        output_path: 输出文件路径
        device: 计算设备
    """
    logger.info(f"🎵 开始生成音乐")
    logger.info(f"   描述: {description}")
    logger.info(f"   时长: {duration}秒")
    
    if output_path is None:
        timestamp = time.strftime('%Y%m%d_%H%M%S')
        output_path = OUTPUT_DIR / f'song_{timestamp}.wav'
    else:
        output_path = Path(output_path)
    
    start_time = time.time()
    
    try:
        from transformers import pipeline
        import torch
        import numpy as np
        import soundfile as sf
        
        logger.info("📦 加载 MusicGen 模型 (facebook/musicgen-small)...")
        logger.info("   首次运行会自动下载模型（约 2GB），请耐心等待...")
        
        # 创建 pipeline
        synth_kwargs = {}
        if device == 'cuda':
            synth_kwargs['device'] = 'cuda'
        else:
            synth_kwargs['device'] = -1  # CPU
        
        synthesiser = pipeline(
            "text-to-audio",
            "facebook/musicgen-small",
            **synth_kwargs,
        )
        
        logger.info(f"✅ 模型加载完成，开始生成...")
        
        # MusicGen-small 单次最大约 30 秒
        if duration <= 30:
            max_tokens = int(duration * 50)  # ~50 tokens/sec
            music = synthesiser(
                description,
                forward_params={"max_new_tokens": max_tokens},
            )
            
            audio_data = music["audio"][0]
            sample_rate = music["sampling_rate"]
        else:
            # 分段生成
            segments = []
            remaining = duration
            seg_count = 0
            
            while remaining > 0:
                seg_count += 1
                seg_duration = min(remaining, 25)
                logger.info(f"   生成第 {seg_count} 段 ({seg_duration}秒)...")
                
                seg_desc = description
                if seg_count > 1:
                    seg_desc = f"{description}, continuation"
                
                max_tokens = int(seg_duration * 50)
                music = synthesiser(
                    seg_desc,
                    forward_params={"max_new_tokens": max_tokens},
                )
                segments.append(music["audio"][0])
                sample_rate = music["sampling_rate"]
                remaining -= seg_duration
            
            # 拼接
            audio_data = np.concatenate(segments)
        
        # 保存
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), audio_data, sample_rate)
        
        elapsed = time.time() - start_time
        file_size = output_path.stat().st_size / 1024 / 1024
        
        logger.info(f"✅ 生成完成！")
        logger.info(f"   文件: {output_path}")
        logger.info(f"   大小: {file_size:.1f}MB")
        logger.info(f"   耗时: {elapsed:.1f}秒")
        
        return str(output_path)
        
    except Exception as e:
        logger.error(f"❌ MusicGen 生成失败: {e}")
        import traceback
        traceback.print_exc()
        raise


def generate_with_lyrics(lyrics, genre="pop", duration=30, output_path=None, device='cuda'):
    """
    根据歌词生成伴奏音乐
    MusicGen 是纯音乐生成器，不包含人声合成。
    它会根据歌词的情感/风格生成匹配的伴奏。
    """
    style_map = {
        'pop': 'upbeat pop music with catchy melody, piano and light drums',
        'rock': 'energetic rock music with electric guitar and drums',
        'folk': 'gentle folk music with acoustic guitar and warm melody',
        'jazz': 'smooth jazz with saxophone and piano',
        'ballad': 'emotional slow ballad with piano and strings',
        'electronic': 'electronic dance music with synth and beat',
        'hiphop': 'hip hop beat with bass and drums',
        'classical': 'classical orchestral music with strings and piano',
    }
    
    description = style_map.get(genre.lower(), style_map['pop'])
    
    # 从歌词推断情感
    if any(word in lyrics for word in ['爱', '心', '梦', '想', '念', 'love', 'heart', 'dream']):
        description += ', emotional and heartfelt'
    if any(word in lyrics for word in ['快乐', '开心', 'happy', 'joy', '笑']):
        description += ', happy and uplifting'
    if any(word in lyrics for word in ['悲伤', '泪', 'sad', 'cry', '痛']):
        description += ', melancholic and touching'
    
    logger.info(f"🎤 歌词风格: {genre}")
    logger.info(f"🎵 音乐描述: {description}")
    
    return generate_musicgen(description, duration, output_path, device)


def main():
    parser = argparse.ArgumentParser(description='AI 歌曲生成器 (MusicGen)')
    parser.add_argument('input', nargs='?', help='歌词文本或音乐描述')
    parser.add_argument('--genre', '-g', default='pop', 
                       choices=['pop', 'rock', 'folk', 'jazz', 'ballad', 'electronic', 'hiphop', 'classical'],
                       help='音乐风格')
    parser.add_argument('--duration', '-d', type=int, default=30, help='时长（秒）')
    parser.add_argument('--output', '-o', help='输出文件路径')
    parser.add_argument('--mode', '-m', default='lyrics', choices=['lyrics', 'description'],
                       help='输入模式：lyrics=歌词, description=直接描述')
    parser.add_argument('--cpu', action='store_true', help='强制使用 CPU')
    
    args = parser.parse_args()
    
    # 默认歌词
    if not args.input:
        args.input = """月光洒在窗前
思念化成诗篇
你的笑容在眼前
却已是昨天

风吹过脸颊
带走了牵挂
把心事写成歌
唱给远方的你"""
        logger.info("📝 使用默认歌词")
    
    device = 'cpu' if args.cpu else check_gpu()
    
    if args.mode == 'description':
        result = generate_musicgen(args.input, args.duration, args.output, device)
    else:
        result = generate_with_lyrics(args.input, args.genre, args.duration, args.output, device)
    
    print(f"\n🎉 完成！音频文件: {result}")
    return result


if __name__ == '__main__':
    main()
