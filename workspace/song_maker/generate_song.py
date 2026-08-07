"""
核心推理脚本 - 使用 DiffRhythm 生成歌曲
支持中文歌词转完整歌曲（人声+伴奏）
"""
import os
import sys
import time
from pathlib import Path
from typing import Optional, Tuple
import torch
import numpy as np
import soundfile as sf

from config import DIFFRHYTHM_CONFIG, OUTPUT_DIR, MODEL_CACHE_DIR


class SongGenerator:
    """歌曲生成器 - 基于 DiffRhythm"""
    
    def __init__(self, device: Optional[str] = None):
        """
        初始化生成器
        
        Args:
            device: 计算设备 ('cuda', 'cpu', 或 None 自动选择)
        """
        self.config = DIFFRHYTHM_CONFIG
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.pipeline = None
        
        print(f"🎵 歌曲生成器初始化")
        print(f"   设备: {self.device}")
        if self.device == "cuda":
            print(f"   GPU: {torch.cuda.get_device_name(0)}")
            print(f"   显存: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")
        print()
    
    def load_model(self) -> bool:
        """
        加载 DiffRhythm 模型
        
        Returns:
            bool: 加载成功返回 True
        """
        print("📦 加载 DiffRhythm 模型...")
        print(f"   模型路径: {self.config['model_path']}")
        print(f"   首次运行会自动下载模型，请耐心等待...")
        print()
        
        try:
            # 尝试导入 diffusers
            from diffusers import DiffusionPipeline
            
            # 设置数据类型
            dtype = torch.float16 if self.config["use_fp16"] and self.device == "cuda" else torch.float32
            
            # 加载 pipeline
            self.pipeline = DiffusionPipeline.from_pretrained(
                self.config["model_path"],
                torch_dtype=dtype,
                cache_dir=str(MODEL_CACHE_DIR / "huggingface"),
            )
            
            # 移动到设备
            self.pipeline = self.pipeline.to(self.device)
            
            # 启用 CPU offload 节省显存
            if self.config["enable_cpu_offload"] and self.device == "cuda":
                print("   启用 CPU offload 优化...")
                self.pipeline.enable_model_cpu_offload()
            
            print("✅ 模型加载成功")
            print()
            return True
            
        except ImportError as e:
            print(f"❌ 缺少依赖: {e}")
            print("   请运行: pip install diffusers transformers accelerate")
            return False
            
        except Exception as e:
            print(f"❌ 模型加载失败: {e}")
            print()
            print("💡 可能的解决方案:")
            print("   1. 检查网络连接（需要下载模型）")
            print("   2. 检查显存是否足够（需要 ~8-10GB）")
            print("   3. 尝试设置 config.py 中的 enable_cpu_offload = True")
            return False
    
    def generate(
        self,
        lyrics: str,
        style: str = "流行",
        duration: Optional[int] = None,
        output_name: Optional[str] = None,
    ) -> Optional[Path]:
        """
        生成歌曲
        
        Args:
            lyrics: 歌词文本
            style: 音乐风格 (流行/摇滚/民谣/电子等)
            duration: 时长（秒），None 则使用配置默认值
            output_name: 输出文件名（不含扩展名）
            
        Returns:
            Path: 生成的音频文件路径，失败返回 None
        """
        if self.pipeline is None:
            print("❌ 模型未加载，请先调用 load_model()")
            return None
        
        # 参数处理
        duration = duration or self.config["audio_duration"]
        output_name = output_name or f"song_{int(time.time())}"
        output_path = OUTPUT_DIR / f"{output_name}.wav"
        
        print("=" * 60)
        print("🎼 开始生成歌曲")
        print("=" * 60)
        print(f"歌词:\n{lyrics}")
        print(f"\n风格: {style}")
        print(f"时长: {duration} 秒")
        print(f"输出: {output_path}")
        print()
        
        # 构建 prompt
        prompt = self._build_prompt(lyrics, style)
        
        print("🔄 生成中...")
        start_time = time.time()
        
        try:
            # 调用 pipeline 生成
            with torch.inference_mode():
                output = self.pipeline(
                    prompt=prompt,
                    num_inference_steps=self.config["num_inference_steps"],
                    guidance_scale=self.config["guidance_scale"],
                    audio_duration=duration,
                )
            
            elapsed = time.time() - start_time
            print(f"✅ 生成完成 (耗时 {elapsed:.1f} 秒)")
            print()
            
            # 提取音频数据
            audio = self._extract_audio(output)
            
            # 保存文件
            print(f"💾 保存音频文件...")
            sf.write(
                str(output_path),
                audio,
                self.config["sample_rate"],
                subtype="PCM_16",
            )
            
            file_size = output_path.stat().st_size / 1024 / 1024
            print(f"✅ 保存成功")
            print(f"   文件大小: {file_size:.1f} MB")
            print(f"   文件路径: {output_path.absolute()}")
            print("=" * 60)
            print()
            
            return output_path
            
        except Exception as e:
            print(f"❌ 生成失败: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    def _build_prompt(self, lyrics: str, style: str) -> str:
        """
        构建生成 prompt
        
        Args:
            lyrics: 歌词
            style: 风格
            
        Returns:
            str: 完整 prompt
        """
        # DiffRhythm 使用歌词作为主要输入
        # 风格作为辅助描述
        prompt = f"[{style}] {lyrics}"
        return prompt
    
    def _extract_audio(self, output) -> np.ndarray:
        """
        从 pipeline 输出提取音频数据
        
        Args:
            output: pipeline 输出对象
            
        Returns:
            np.ndarray: 音频数据
        """
        # DiffRhythm 输出格式可能是 dict 或 object
        if isinstance(output, dict):
            audio = output.get("audio", output.get("waveform"))
        elif hasattr(output, "audio"):
            audio = output.audio
        elif hasattr(output, "waveform"):
            audio = output.waveform
        else:
            # 尝试直接作为 numpy array
            audio = output
        
        # 转换为 numpy
        if isinstance(audio, torch.Tensor):
            audio = audio.cpu().numpy()
        
        # 确保是正确的形状 (samples,) 或 (channels, samples)
        if audio.ndim == 1:
            # 单声道
            pass
        elif audio.ndim == 2:
            # 可能是 (batch, samples) 或 (channels, samples)
            if audio.shape[0] == 1:
                audio = audio[0]
            elif audio.shape[0] == 2:
                # 立体声，转置为 (samples, channels)
                audio = audio.T
        
        # 归一化到 [-1, 1]
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        
        max_val = np.abs(audio).max()
        if max_val > 1.0:
            audio = audio / max_val
        
        return audio


def main():
    """命令行入口"""
    import argparse
    
    parser = argparse.ArgumentParser(description="AI 歌曲生成器")
    parser.add_argument("lyrics", help="歌词文本或歌词文件路径")
    parser.add_argument("--style", default="流行", help="音乐风格")
    parser.add_argument("--duration", type=int, default=30, help="时长（秒）")
    parser.add_argument("--output", help="输出文件名")
    parser.add_argument("--cpu", action="store_true", help="强制使用 CPU")
    
    args = parser.parse_args()
    
    # 读取歌词
    lyrics_path = Path(args.lyrics)
    if lyrics_path.exists():
        lyrics = lyrics_path.read_text(encoding="utf-8")
    else:
        lyrics = args.lyrics
    
    # 初始化生成器
    device = "cpu" if args.cpu else None
    generator = SongGenerator(device=device)
    
    # 加载模型
    if not generator.load_model():
        sys.exit(1)
    
    # 生成歌曲
    output = generator.generate(
        lyrics=lyrics,
        style=args.style,
        duration=args.duration,
        output_name=args.output,
    )
    
    if output:
        print(f"\n🎉 生成成功！文件位置: {output}")
        sys.exit(0)
    else:
        print("\n❌ 生成失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
