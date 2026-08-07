# -*- coding: utf-8 -*-
"""
MusicGen 实际推理测试 - 生成 8 秒音乐
验证: GPU 检测 -> 模型加载 -> 推理 -> WAV 输出 全链路
"""
import os
import sys
import time
import logging
from pathlib import Path

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('test_gen')

OUTPUT_DIR = Path(__file__).parent / 'output'
OUTPUT_DIR.mkdir(exist_ok=True)


def main():
    t0 = time.time()
    
    # 1. GPU 检测
    import torch
    assert torch.cuda.is_available(), "CUDA 不可用"
    props = torch.cuda.get_device_properties(0)
    logger.info(f"GPU: {torch.cuda.get_device_name(0)} | 显存: {props.total_memory/1024**3:.1f}GB | 空闲: {torch.cuda.mem_get_info()[0]/1024**3:.1f}GB")
    
    # 2. 加载模型
    logger.info("加载 MusicGen-small...")
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    
    model_id = "facebook/musicgen-small"
    processor = AutoProcessor.from_pretrained(model_id)
    model = MusicgenForConditionalGeneration.from_pretrained(model_id).to('cuda')
    logger.info(f"模型加载完成, 耗时 {time.time()-t0:.1f}s")
    
    # 3. 推理 - 8 秒
    logger.info("开始生成 8 秒音乐...")
    inputs = processor(
        text=["upbeat pop music with piano and light drums"],
        padding=True,
        return_tensors="pt",
    ).to('cuda')
    
    audio_values = model.generate(**inputs, max_new_tokens=400)  # 8秒 * 50 tokens/s
    logger.info(f"生成完成, 耗时 {time.time()-t0:.1f}s")
    
    # 4. 保存
    import soundfile as sf
    audio = audio_values[0, 0].cpu().numpy()
    out_path = OUTPUT_DIR / 'test_8s.wav'
    sf.write(str(out_path), audio, processor.feature_extractor.sampling_rate)
    
    size_mb = out_path.stat().st_size / 1024 / 1024
    logger.info(f"✅ 已保存: {out_path} | {size_mb:.2f}MB | 采样率 {processor.feature_extractor.sampling_rate}")
    logger.info(f"总耗时: {time.time()-t0:.1f}s")
    
    # 5. 显存释放检查
    logger.info(f"生成后显存占用: {torch.cuda.memory_allocated()/1024**3:.2f}GB")
    
    print(f"RESULT:{out_path}")


if __name__ == '__main__':
    main()
