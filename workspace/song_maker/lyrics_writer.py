"""
AI 作词模块 - 调用灵犀引擎 LLM 生成歌词
"""
import json
from typing import Optional
import httpx

from config import LYRICS_CONFIG


class LyricsWriter:
    """AI 作词器"""
    
    def __init__(self, api_url: Optional[str] = None):
        """
        初始化作词器
        
        Args:
            api_url: 灵犀引擎 API 地址
        """
        self.config = LYRICS_CONFIG
        self.api_url = api_url or self.config["engine_api"]
        self.client = httpx.Client(timeout=60.0)
        
        print(f"✍️  作词器初始化")
        print(f"   API: {self.api_url}")
        print()
    
    def write_lyrics(
        self,
        theme: str,
        style: Optional[str] = None,
        structure: str = "verse-chorus",
        language: str = "zh",
    ) -> Optional[str]:
        """
        生成歌词
        
        Args:
            theme: 主题描述
            style: 音乐风格
            structure: 歌曲结构 (verse-chorus / aaba / free)
            language: 语言 (zh / en)
            
        Returns:
            str: 歌词文本，失败返回 None
        """
        style = style or self.config["default_style"]
        
        print("=" * 60)
        print("✍️  开始创作歌词")
        print("=" * 60)
        print(f"主题: {theme}")
        print(f"风格: {style}")
        print(f"结构: {structure}")
        print(f"语言: {language}")
        print()
        
        # 构建 prompt
        prompt = self._build_prompt(theme, style, structure, language)
        
        try:
            # 调用灵犀引擎 API
            response = self.client.post(
                f"{self.api_url}/api/chat",
                json={
                    "message": prompt,
                    "model": "default",
                },
            )
            
            if response.status_code == 200:
                data = response.json()
                lyrics = data.get("response", "").strip()
                
                print("✅ 歌词生成成功")
                print()
                print("歌词内容:")
                print("-" * 60)
                print(lyrics)
                print("-" * 60)
                print()
                
                return lyrics
            else:
                print(f"❌ API 调用失败: {response.status_code}")
                print(f"   {response.text}")
                return None
                
        except httpx.ConnectError:
            print(f"❌ 无法连接到灵犀引擎")
            print(f"   请确保灵犀引擎运行在 {self.api_url}")
            print()
            print("💡 备选方案: 手动输入歌词")
            return None
            
        except Exception as e:
            print(f"❌ 作词失败: {e}")
            return None
    
    def _build_prompt(
        self,
        theme: str,
        style: str,
        structure: str,
        language: str,
    ) -> str:
        """构建作词 prompt"""
        
        lang_desc = "中文" if language == "zh" else "英文"
        
        structure_desc = {
            "verse-chorus": "主歌-副歌结构（2段主歌 + 2段副歌 + 桥段）",
            "aaba": "AABA 结构（3段A段 + 1段B段）",
            "free": "自由结构",
        }.get(structure, structure)
        
        prompt = f"""你是一位专业的{lang_desc}作词人。请根据以下要求创作一首歌词：

主题：{theme}
风格：{style}
结构：{structure_desc}

要求：
1. 歌词要有意境和情感，避免空洞的套话
2. 押韵自然，不要生硬
3. 每句歌词长度适中，适合演唱
4. 使用 {lang_desc} 创作
5. 直接输出歌词，不要加标题或说明

请开始创作："""
        
        return prompt
    
    def refine_lyrics(self, lyrics: str, feedback: str) -> Optional[str]:
        """
        修改歌词
        
        Args:
            lyrics: 原歌词
            feedback: 修改意见
            
        Returns:
            str: 修改后的歌词
        """
        prompt = f"""请根据以下意见修改歌词：

原歌词：
{lyrics}

修改意见：
{feedback}

请直接输出修改后的歌词："""
        
        try:
            response = self.client.post(
                f"{self.api_url}/api/chat",
                json={
                    "message": prompt,
                    "model": "default",
                },
            )
            
            if response.status_code == 200:
                data = response.json()
                return data.get("response", "").strip()
            else:
                return None
                
        except Exception:
            return None


def main():
    """命令行测试"""
    import argparse
    
    parser = argparse.ArgumentParser(description="AI 作词器")
    parser.add_argument("theme", help="歌曲主题")
    parser.add_argument("--style", default="流行", help="音乐风格")
    parser.add_argument("--structure", default="verse-chorus", help="歌曲结构")
    parser.add_argument("--language", default="zh", help="语言")
    parser.add_argument("--output", help="输出文件路径")
    
    args = parser.parse_args()
    
    writer = LyricsWriter()
    lyrics = writer.write_lyrics(
        theme=args.theme,
        style=args.style,
        structure=args.structure,
        language=args.language,
    )
    
    if lyrics:
        if args.output:
            from pathlib import Path
            Path(args.output).write_text(lyrics, encoding="utf-8")
            print(f"💾 歌词已保存到: {args.output}")
        else:
            print("\n最终歌词:")
            print(lyrics)


if __name__ == "__main__":
    main()
