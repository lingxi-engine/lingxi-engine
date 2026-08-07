"""
AI 歌曲生成核心脚本
支持 DiffRhythm 和 YuE 两种模型（按可用性自动选择）
"""
import os
import sys
import json
import time
import torch
import argparse
import logging

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['PYTHONIOENCODING'] = 'utf-8'

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('song_generator')

# ============================================================
# 模型加载器
# ============================================================

class DiffRhythmGenerator:
    """DiffRhythm 歌曲生成器 - 歌词转完整歌曲（人声+伴奏）"""
    
    def __init__(self, model_path=None, device='cuda'):
        self.device = device
        self.model = None
        self.model_path = model_path or "ASLP-lab/DiffRhythm"
        self.loaded = False
    
    def load_model(self):
        """加载 DiffRhythm 模型"""
        logger.info(f"正在加载 DiffRhythm 模型: {self.model_path}")
        start = time.time()
        
        try:
            # 尝试从 diffusers 加载（如果已集成）
            from diffusers import DiffRhythmPipeline
            self.model = DiffRhythmPipeline.from_pretrained(
                self.model_path,
                torch_dtype=torch.float16 if self.device == 'cuda' else torch.float32,
            )
            self.model.to(self.device)
            self.loaded = True
            logger.info(f"DiffRhythm 加载完成，耗时 {time.time()-start:.1f}s")
            return True
        except ImportError:
            logger.info("diffusers 未集成 DiffRhythm，尝试从本地仓库加载...")
        
        try:
            # 尝试从本地克隆的 DiffRhythm 仓库加载
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'DiffRhythm'))
            from inference import DiffRhythmInference
            self.model = DiffRhythmInference(
                model_path=self.model_path,
                device=self.device,
            )
            self.loaded = True
            logger.info(f"DiffRhythm (本地) 加载完成，耗时 {time.time()-start:.1f}s")
            return True
        except Exception as e:
            logger.warning(f"DiffRhythm 本地加载失败: {e}")
        
        return False
    
    def generate(self, lyrics, genre="pop", duration=60, output_path="output_song.wav"):
        """
        生成歌曲
        
        Args:
            lyrics: 歌词文本（中文或英文）
            genre: 音乐风格 (pop/rock/folk/jazz/hiphop)
            duration: 目标时长（秒）
            output_path: 输出文件路径
        """
        if not self.loaded:
            raise RuntimeError("模型未加载，请先调用 load_model()")
        
        logger.info(f"开始生成歌曲 - 风格: {genre}, 时长: {duration}s")
        logger.info(f"歌词: {lyrics[:100]}...")
        
        start = time.time()
        
        # 调用模型推理
        audio = self.model.generate(
            lyrics=lyrics,
            genre=genre,
            duration=duration,
        )
        
        elapsed = time.time() - start
        logger.info(f"生成完成，耗时 {elapsed:.1f}s")
        
        # 保存音频
        import soundfile as sf
        sf.write(output_path, audio, samplerate=44100)
        logger.info(f"已保存: {output_path}")
        
        return output_path


class YuEGenerator:
    """YuE 歌曲生成器 - 基于 LLaMA 的歌词转歌曲"""
    
    def __init__(self, model_path=None, device='cuda', quantize='int4'):
        self.device = device
        self.model = None
        self.processor = None
        self.model_path = model_path or "m-a-p/YuE-s1-7B-anneal"
        self.quantize = quantize
        self.loaded = False
    
    def load_model(self):
        """加载 YuE 模型（INT4 量化适配 12GB 显存）"""
        logger.info(f"正在加载 YuE 模型: {self.model_path}")
        start = time.time()
        
        try:
            from transformers import AutoTokenizer, AutoModelForCausalLM
            
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
                    self.model_path,
                    quantization_config=quant_config,
                    device_map="auto",
                    trust_remote_code=True,
                )
            else:
                self.model = AutoModelForCausalLM.from_pretrained(
                    self.model_path,
                    torch_dtype=torch.float16,
                    device_map="auto",
                    trust_remote_code=True,
                )
            
            self.processor = AutoTokenizer.from_pretrained(
                self.model_path,
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
            raise RuntimeError("模型未加载")
        
        logger.info(f"YuE 开始生成 - 风格: {genre}")
        # YuE 生成流程
        prompt = f"Generate a {genre} song with the following lyrics:\n{lyrics}"
        inputs = self.processor(prompt, return_tensors="pt").to(self.device)
        
        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=True,
                temperature=0.8,
            )
        
        # 解码音频 token
        audio = self.model.decode_audio(outputs)
        
        import soundfile as sf
        sf.write(output_path, audio, samplerate=44100)
        logger.info(f"已保存: {output_path}")
        return output_path


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
        print("🎵 AI 歌曲生成器")
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
            else:
                gen = YuEGenerator(device=self.device)
            
            if gen.load_model():
                self.generator = gen
                self.model_name = model_name
                print(f"✅ 使用模型: {model_name}")
                return True
            else:
                print(f"⚠️  {model_name} 加载失败，尝试下一个...")
        
        print("❌ 所有模型加载失败")
        return False
    
    def generate_song(self, lyrics, genre="pop", duration=60, output_path="output_song.wav"):
        """
        生成完整歌曲
        
        Args:
            lyrics: 歌词文本
            genre: 风格 (pop/rock/folk/jazz/hiphop/electronic)
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
    parser = argparse.ArgumentParser(description='AI 歌曲生成器')
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
        lyrics = """
[verse]
阳光穿过窗帘的缝隙
照亮了桌上冷却的咖啡
又是一个安静的早晨
时间慢得像一首老歌

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
