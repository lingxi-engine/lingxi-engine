"""
作词模块 - 使用 LLM 生成中文歌词
支持 Qwen2.5 或其他中文 LLM
"""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from pathlib import Path
import json

class LyricsGenerator:
    """歌词生成器"""
    
    def __init__(self, model_id: str = "Qwen/Qwen2.5-7B-Instruct", 
                 device: str = "cuda", quant: str = "4bit"):
        self.model_id = model_id
        self.device = device
        self.quant = quant
        self.model = None
        self.tokenizer = None
        
    def load_model(self):
        """加载 LLM 模型"""
        print(f"[LyricsGenerator] Loading model: {self.model_id}")
        
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_id, 
            trust_remote_code=True
        )
        
        # 4bit 量化加载，节省显存
        if self.quant == "4bit":
            from transformers import BitsAndBytesConfig
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
            )
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_id,
                quantization_config=bnb_config,
                device_map="auto",
                trust_remote_code=True,
                torch_dtype=torch.float16,
            )
        else:
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_id,
                device_map="auto",
                trust_remote_code=True,
                torch_dtype=torch.float16,
            )
        
        print("[LyricsGenerator] Model loaded successfully")
        
    def generate(self, theme: str, style: str = "流行", 
                 structure: str = "verse-chorus-verse-chorus-bridge-chorus",
                 max_tokens: int = 1024) -> dict:
        """
        生成歌词
        
        Args:
            theme: 歌曲主题，如 "失恋后的成长"
            style: 音乐风格，如 "流行", "民谣", "摇滚"
            structure: 歌曲结构
            max_tokens: 最大生成 token 数
            
        Returns:
            dict: {
                "lyrics": "完整歌词文本",
                "sections": [{"type": "verse", "text": "..."}, ...]
            }
        """
        if self.model is None:
            self.load_model()
            
        prompt = f"""你是一位专业的中文作词人。请根据以下要求创作一首歌词：

主题：{theme}
风格：{style}
结构：{structure}

要求：
1. 使用优美、押韵的中文
2. 每段标注 [verse]、[chorus]、[bridge] 等
3. 歌词要有意境和情感
4. 适合演唱，注意音节数量

请直接输出歌词，不要解释：
"""
        
        messages = [
            {"role": "system", "content": "你是一位才华横溢的中文作词人，擅长创作富有情感和意境的歌词。"},
            {"role": "user", "content": prompt}
        ]
        
        text = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )
        
        inputs = self.tokenizer([text], return_tensors="pt").to(self.device)
        
        outputs = self.model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=True,
            temperature=0.8,
            top_p=0.9,
            repetition_penalty=1.1,
        )
        
        response = self.tokenizer.decode(
            outputs[0][inputs.input_ids.shape[1]:], 
            skip_special_tokens=True
        )
        
        # 解析歌词结构
        sections = self._parse_sections(response)
        
        return {
            "lyrics": response,
            "sections": sections
        }
    
    def _parse_sections(self, lyrics_text: str) -> list:
        """解析歌词段落结构"""
        sections = []
        current_type = "unknown"
        current_lines = []
        
        for line in lyrics_text.split('\n'):
            line = line.strip()
            if not line:
                continue
                
            # 检测段落标记
            if line.startswith('[') and line.endswith(']'):
                # 保存上一段
                if current_lines:
                    sections.append({
                        "type": current_type,
                        "text": '\n'.join(current_lines)
                    })
                
                # 开始新段落
                current_type = line[1:-1].lower()
                current_lines = []
            else:
                current_lines.append(line)
        
        # 保存最后一段
        if current_lines:
            sections.append({
                "type": current_type,
                "text": '\n'.join(current_lines)
            })
        
        return sections
    
    def generate_simple(self, theme: str) -> str:
        """简化版：直接返回歌词文本"""
        result = self.generate(theme)
        return result["lyrics"]


# 便捷函数
def generate_lyrics(theme: str, style: str = "流行") -> dict:
    """
    快速生成歌词（无需手动实例化）
    
    Example:
        lyrics = generate_lyrics("夏日海边的回忆", "流行")
        print(lyrics["lyrics"])
    """
    gen = LyricsGenerator()
    gen.load_model()
    return gen.generate(theme, style)


if __name__ == "__main__":
    # 测试
    print("Testing lyrics generation...")
    result = generate_lyrics("城市夜晚的孤独", "民谣")
    print("\n=== Generated Lyrics ===")
    print(result["lyrics"])
    print("\n=== Sections ===")
    for sec in result["sections"]:
        print(f"[{sec['type']}]")
        print(sec['text'])
        print()
