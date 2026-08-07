# -*- coding: utf-8 -*-
"""
完整 Demo 歌曲生成 - 30 秒中文流行风
输入: 中文歌词 -> 风格映射 -> MusicGen 生成 -> WAV
"""
import os
import time
import logging
from pathlib import Path

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('demo_gen')

OUTPUT_DIR = Path(__file__).parent / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)

# 默认歌词
DEFAULT_LYRICS = """
月光洒在窗前
思念化成诗篇
你的笑容在眼前
却已是昨天

风吹过脸颊
带走了牵挂
把心事写成歌
唱给远方的你
"""

# 风格映射表
STYLE_MAP = {
    'pop': 'upbeat pop music with catchy melody, piano and light drums',
    'rock': 'energetic rock music with electric guitar and drums',
    'folk': 'gentle folk music with acoustic guitar and warm melody',
    'jazz': 'smooth jazz with saxophone and piano',
    'ballad': 'emotional slow ballad with piano and strings',
    'electronic': 'electronic dance music with synth and beat',
    'hiphop': 'hip hop beat with bass and drums',
    'classical': 'classical orchestral music with strings and piano',
}


def lyrics_to_description(lyrics, genre='pop'):
    """根据歌词情感推断音乐描述"""
    desc = STYLE_MAP.get(genre.lower(), STYLE_MAP['pop'])
    if any(w in lyrics for w in ['爱', '心', '梦', '想', '念', 'love', 'heart', 'dream']):
        desc += ', emotional and heartfelt'
    if any(w in lyrics for w in ['快乐', '开心', 'happy', 'joy', '笑']):
        desc += ', happy and uplifting'
    if any(w in lyrics for w in ['悲伤', '泪', 'sad', 'cry', '痛']):
        desc += ', melancholic and touching'
    return desc


def generate_song(lyrics, genre='pop', duration=30, output_path=None):
    """生成完整歌曲"""
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    t0 = time.time()
    props = torch.cuda.get_device_properties(0)
    logger.info(f"GPU: {torch.cuda.get_device_name(0)} | 显存 {props.total_memory/1024**3:.1f}GB")

    # 歌词 -> 音乐描述
    description = lyrics_to_description(lyrics, genre)
    logger.info(f"风格: {genre}")
    logger.info(f"描述: {description}")

    # 加载模型
    logger.info("加载 MusicGen-small...")
    model_id = "facebook/musicgen-small"
    processor = AutoProcessor.from_pretrained(model_id)
    model = MusicgenForConditionalGeneration.from_pretrained(model_id).to('cuda')
    logger.info(f"模型就绪, 耗时 {time.time()-t0:.1f}s")

    # 生成（30秒 = 1500 tokens）
    logger.info(f"生成 {duration} 秒音乐...")
    inputs = processor(text=[description], padding=True, return_tensors="pt").to('cuda')
    audio_values = model.generate(**inputs, max_new_tokens=int(duration * 50))
    logger.info(f"推理完成, 耗时 {time.time()-t0:.1f}s")

    # 保存
    import soundfile as sf
    audio = audio_values[0, 0].cpu().numpy()
    if output_path is None:
        ts = time.strftime('%Y%m%d_%H%M%S')
        output_path = OUTPUT_DIR / f'demo_{genre}_{ts}.wav'
    else:
        output_path = Path(output_path)

    sr = processor.feature_extractor.sampling_rate
    sf.write(str(output_path), audio, sr)

    size_mb = output_path.stat().st_size / 1024 / 1024
    logger.info(f"✅ 完成: {output_path} | {size_mb:.2f}MB | {sr}Hz | 时长 {duration}s")
    logger.info(f"总耗时: {time.time()-t0:.1f}s")
    print(f"RESULT:{output_path}")
    return str(output_path)


if __name__ == '__main__':
    import sys
    lyrics = DEFAULT_LYRICS
    if len(sys.argv) > 1 and sys.argv[1].strip():
        lyrics = sys.argv[1]
    genre = sys.argv[2] if len(sys.argv) > 2 else 'pop'
    duration = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    generate_song(lyrics, genre, duration)
