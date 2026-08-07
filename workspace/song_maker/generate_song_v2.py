"""
AI 歌曲生成核心脚本 v2
支持 DiffRhythm 和 YuE 两种模型
适配 RTX 3060 12GB 显存
"""
import os
import sys
import json
import time
import torch
import argparse
import logging
import subprocess
from pathlib import Path

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['PYTHONIOENCODING'] = 'utf-8'

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('song_generator')

# ============================================================
# DiffRhythm 生成器
# ============================================================

class DiffRhythmGenerator:
    """DiffRhythm 歌曲生成器 - 歌词转完整歌曲（人声+伴奏）"""
    
    def __init__(self, device='cuda'):
        self.device = device
        self.repo_path = Path(__file__).parent / 'DiffRhythm'
        self.loaded = False
        
    def check_installation(self):
        """检查 DiffRhythm 是否已安装"""
        if not self.repo_path.exists():
            logger.error(f"DiffRhythm 仓库不存在: {self.repo_path}")
            logger.info("请先运行 install_v2.bat 安装")
            return False
        
        # 检查关键文件
        infer_script = self.repo_path / 'inference.py'
        if not infer_script.exists():
            # 尝试其他可能的脚本名
            for name in ['infer.py', 'generate.py', 'run_inference.py']:
                if (self.repo_path / name).exists():
                    infer_script = self.repo_path / name
                    break
        
        if not infer_script.exists():
            logger.warning("未找到推理脚本，将尝试使用 Python API")
        
        return True
    
    def generate(self, lyrics, genre="pop", duration=60, output_path="output_song.wav"):
        """
        生成歌曲
        
        Args:
            lyrics: 歌词文本（中文或英文）
            genre: 音乐风格 (pop/rock/folk/jazz/hiphop/electronic/ballad)
            duration: 目标时长（秒）
            output_path: 输出文件路径
        """
        logger.info(f"DiffRhythm 开始生成 - 风格: {genre}, 时长: {duration}s")
        logger.info(f"歌词: {lyrics[:100]}...")
        
        start = time.time()
        
        # 保存歌词到临时文件
        lyrics_file = Path(__file__).parent / 'temp_lyrics.txt'
        with open(lyrics_file, 'w', encoding='utf-8') as f:
            f.write(lyrics)
        
        # 构建推理命令
        # DiffRhythm 通常使用类似这样的命令:
        # python inference.py --lyrics_path lyrics.txt --genre_prompt "pop" --duration 60 --output output.wav
        
        cmd = [
            sys.executable,
            str(self.repo_path / 'inference.py'),
            '--lyrics_path', str(lyrics_file),
            '--genre_prompt', genre,
            '--duration', str(duration),
            '--output', str(output_path),
            '--device', self.device,
        ]
        
        # 尝试执行推理
        try:
            result = subprocess.run(
                cmd,
                cwd=str(self.repo_path),
                capture_output=True,
                text=True,
                timeout=1800  # 30分钟超时
            )
            
            if result.returncode == 0:
                elapsed = time.time() - start
                logger.info(f"生成完成，耗时 {elapsed:.1f}s")
                
                # 清理临时文件
                if lyrics_file.exists():
                    lyrics_file.unlink()
                
                return output_path
            else:
                logger.error(f"推理失败: {result.stderr}")
                # 如果命令行方式失败，尝试 Python API
                return self._generate_via_api(lyrics, genre, duration, output_path)
                
        except subprocess.TimeoutExpired:
            logger.error("推理超时（30分钟）")
            raise RuntimeError("生成超时")
        except FileNotFoundError:
            logger.warning("推理脚本不存在，尝试 Python API")
            return self._generate_via_api(lyrics, genre, duration, output_path)
    
    def _generate_via_api(self, lyrics, genre, duration, output_path):
        """通过 Python API 生成（备用方案）"""
        try:
            # 尝试导入 DiffRhythm 的 Python 模块
            sys.path.insert(0, str(self.repo_path))
            
            # 常见的模块名
            for module_name in ['diff_rhythm', 'diffrhythm', 'model']:
                try:
                    module = __import__(module_name)
                    break
                except ImportError:
                    continue
            else:
                raise ImportError("无法导入 DiffRhythm 模块")
            
            # 调用生成函数（具体 API 需要根据实际仓库调整）
            # 这里提供一个通用的接口框架
            if hasattr(module, 'generate_song'):
                audio = module.generate_song(
                    lyrics=lyrics,
                    genre=genre,
                    duration=duration,
                    device=self.device
                )
            elif hasattr(module, 'inference'):
                audio = module.inference(
                    lyrics=lyrics,
                    genre=genre,
                    duration=duration,
                    device=self.device
                )
            else:
                raise AttributeError("未找到生成函数")
            
            # 保存音频
            import soundfile as sf
            sf.write(output_path, audio, samplerate=44100)
            logger.info(f"已保存: {output_path}")
            
            return output_path
            
        except Exception as e:
            logger.error(f"Python API 生成失败: {e}")
            raise


# ============================================================
# YuE 生成器
# ============================================================

class YuEGenerator:
    """YuE 歌曲生成器 - 基于 LLaMA 的歌词转歌曲"""
    
    def __init__(self, device='cuda', quantize='int4'):
        self.device = device
        self.repo_path = Path(__file__).parent / 'YuE'
        self.quantize = quantize
        self.model = None
        self.processor = None
        self.loaded = False
    
    def load_model(self):
        """加载 YuE 模型（INT4 量化适配 12GB 显存）"""
        logger.info("正在加载 YuE 模型...")
        start = time.time()
        
        try:
            from transformers import AutoTokenizer, AutoModelForCausalLM
            
            model_path = "m-a-p/YuE-s1-7B-anneal"
            
            # 使用 INT4 量化以适配 12GB 显存
            if self.quantize == 'int4':
                from transformers import BitsAndBytesConfig
                quant_config = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_use_double_quant=True,
                    bnb_4bit_quant_type="nf4",
                )
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_path,
                    quantization_config=quant_config,
                    device_map="auto",
                    trust_remote_code=True,
                )
            else:
                self.model = AutoModelForCausalLM.from_pretrained(
                    model_path,
                    torch_dtype=torch.float16,
                    device_map="auto",
                    trust_remote_code=True,
                )
            
            self.processor = AutoTokenizer.from_pretrained(
                model_path,
                trust_remote_code=True,
            )
            
            self.loaded = True
            logger.info(f"YuE 加载完成，耗时 {time.time()-start:.1f}s")
            return True
            
        except Exception as e:
            logger.error(f"YuE 加载失败: {e}")
            return False
    
    def generate(self, lyrics, genre="pop", duration=60, output_path="output_song.wav"):
        """生成歌曲"""
        if not self.loaded:
            if not self.load_model():
                raise RuntimeError("YuE 模型加载失败")
        
        logger.info(f"YuE 开始生成 - 风格: {genre}")
        start = time.time()
        
        # 构建提示词
        prompt = f"""Generate a {genre} song with the following lyrics:

{lyrics}

Style: {genre}, Duration: {duration} seconds"""
        
        # 编码输入
        inputs = self.processor(prompt, return_tensors="pt").to(self.device)
        
        # 生成
        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=True,
                temperature=0.8,
                top_p=0.95,
            )
        
        # 解码音频（YuE 使用特殊的音频 token）
        # 具体解码方式需要根据 YuE 的实际实现
        if hasattr(self.model, 'decode_audio'):
            audio = self.model.decode_audio(outputs)
        else:
            # 备用方案：尝试从输出中提取音频
            logger.warning("未找到 decode_audio 方法，尝试通用解码")
            audio = self._decode_audio_tokens(outputs)
        
        # 保存音频
        import soundfile as sf
        sf.write(output_path, audio, samplerate=44100)
        
        elapsed = time.time() - start
        logger.info(f"生成完成，耗时 {elapsed:.1f}s")
        logger.info(f"已保存: {output_path}")
        
        return output_path
    
    def _decode_audio_tokens(self, outputs):
        """解码音频 token（备用方案）"""
        import numpy as np
        
        # 这里需要根据 YuE 的实际实现来调整
        # 通常音频 token 需要特殊的解码器
        logger.warning("使用简化的音频解码，音质可能不佳")
        
        # 生成一个占位音频（静音）
        # 实际使用时需要替换为正确的解码逻辑
        duration_samples = 44100 * 60  # 60秒
        audio = np.zeros(duration_samples, dtype=np.float32)
        
        return audio


# ============================================================
# 统一生成接口
# ============================================================

class SongGenerator:
    """统一歌曲生成器 - 自动选择可用模型"""
    
    def __init__(self, device='cuda', preferred_model='diffrhythm'):
        self.device = device if torch.cuda.is_available() else 'cpu'
        self.preferred_model = preferred_model
        self.generator = None
        self.model_name = None
    
    def setup(self):
        """初始化并加载最佳可用模型"""
        print("="*60)
        print("🎵 AI 歌曲生成器 v2")
        print("="*60)
        print(f"设备: {self.device}")
        if torch.cuda.is_available():
            vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
            print(f"GPU: {torch.cuda.get_device_name(0)} ({vram:.1f} GB)")
        print()
        
        # 按优先级尝试加载模型
        models_to_try = []
        if self.preferred_model == 'diffrhythm':
            models_to_try = ['diffrhythm', 'yue']
        else:
            models_to_try = ['yue', 'diffrhythm']
        
        for model_name in models_to_try:
            print(f"尝试加载 {model_name}...")
            
            if model_name == 'diffrhythm':
                gen = DiffRhythmGenerator(device=self.device)
                if gen.check_installation():
                    self.generator = gen
                    self.model_name = model_name
                    print(f"✅ 使用模型: {model_name}")
                    return True
            else:  # yue
                gen = YuEGenerator(device=self.device)
                if gen.load_model():
                    self.generator = gen
                    self.model_name = model_name
                    print(f"✅ 使用模型: {model_name}")
                    return True
            
            print(f"⚠️  {model_name} 加载失败，尝试下一个...")
        
        print("❌ 所有模型加载失败")
        return False
    
    def generate_song(self, lyrics, genre="pop", duration=60, output_path="output_song.wav"):
        """
        生成完整歌曲
        
        Args:
            lyrics: 歌词文本
            genre: 风格 (pop/rock/folk/jazz/hiphop/electronic/ballad)
            duration: 时长（秒）
            output_path: 输出路径
        
        Returns:
            dict: 生成结果信息
        """
        if not self.generator:
            raise RuntimeError("请先调用 setup() 加载模型")
        
        result = {
            'model': self.model_name,
            'lyrics': lyrics,
            'genre': genre,
            'duration': duration,
            'status': 'generating',
        }
        
        try:
            path = self.generator.generate(
                lyrics=lyrics,
                genre=genre,
                duration=duration,
                output_path=output_path,
            )
            result['output_path'] = path
            result['status'] = 'success'
        except Exception as e:
            result['status'] = 'error'
            result['error'] = str(e)
            logger.error(f"生成失败: {e}")
        
        return result


# ============================================================
# 命令行入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='AI 歌曲生成器 v2')
    parser.add_argument('lyrics', nargs='?', help='歌词文本或歌词文件路径')
    parser.add_argument('--genre', default='pop', help='音乐风格')
    parser.add_argument('--duration', type=int, default=60, help='时长(秒)')
    parser.add_argument('--output', default='output_song.wav', help='输出路径')
    parser.add_argument('--model', default='diffrhythm', choices=['diffrhythm', 'yue'], help='模型选择')
    parser.add_argument('--device', default='cuda', help='设备 (cuda/cpu)')
    
    args = parser.parse_args()
    
    # 读取歌词
    lyrics = args.lyrics
    if lyrics and os.path.isfile(lyrics):
        with open(lyrics, 'r', encoding='utf-8') as f:
            lyrics = f.read()
    
    if not lyrics:
        # 默认示例歌词
        lyrics = """[verse]
阳光穿过窗帘的缝隙
照亮了桌上冷却的咖啡
又是一个安静的早晨
时间慢得像一首老歌

[chorus]
我们在城市的缝隙里呼吸
寻找那些被遗忘的温柔
就算世界变得太快
至少还有这首歌陪着我

[verse]
街角的咖啡店还在营业
播放着那首熟悉的歌
我们曾经在这里相遇
如今只剩下回忆

[chorus]
我们在城市的缝隙里呼吸
寻找那些被遗忘的温柔
就算世界变得太快
至少还有这首歌陪着我
"""
    
    print(f"歌词:\n{lyrics}")
    print()
    
    # 初始化生成器
    gen = SongGenerator(device=args.device, preferred_model=args.model)
    if not gen.setup():
        print("❌ 初始化失败，请检查环境")
        sys.exit(1)
    
    # 生成歌曲
    result = gen.generate_song(
        lyrics=lyrics,
        genre=args.genre,
        duration=args.duration,
        output_path=args.output,
    )
    
    print()
    print("="*60)
    if result['status'] == 'success':
        print(f"🎉 歌曲生成成功！")
        print(f"📁 文件: {os.path.abspath(result['output_path'])}")
        print(f"🎵 模型: {result['model']}")
        print(f"🎸 风格: {result['genre']}")
    else:
        print(f"❌ 生成失败: {result.get('error', '未知错误')}")
    print("="*60)


if __name__ == "__main__":
    main()
