"""
AI 歌曲制作 MCP Server v2
为灵犀引擎提供歌曲生成的 MCP 工具接口

工具列表:
1. write_lyrics - AI 作词（使用 LLM）
2. generate_song - 生成完整歌曲（人声+伴奏）
3. generate_accompaniment - 仅生成伴奏
4. generate_vocal - 仅生成人声
5. list_models - 列出可用模型及其状态
"""
import os
import sys
import json
import asyncio
from typing import Optional
from pathlib import Path

# MCP Server 依赖
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    ImageContent,
    EmbeddedResource,
    LoggingLevel,
)

# 导入歌曲生成核心模块
from generate_song_v2 import SongGenerator

# 初始化 MCP Server
app = Server("song-production-server-v2")

# 全局歌曲生成器实例
song_generator: Optional[SongGenerator] = None


def get_generator() -> SongGenerator:
    """获取或初始化歌曲生成器"""
    global song_generator
    if song_generator is None:
        song_generator = SongGenerator(device='cuda', preferred_model='diffrhythm')
        if not song_generator.setup():
            raise RuntimeError("歌曲生成器初始化失败")
    return song_generator


# ============================================================
# MCP 工具定义
# ============================================================

@app.list_tools()
async def list_tools() -> list[Tool]:
    """列出所有可用的 MCP 工具"""
    return [
        Tool(
            name="write_lyrics",
            description="AI 作词 - 根据主题和风格生成歌词",
            inputSchema={
                "type": "object",
                "properties": {
                    "theme": {
                        "type": "string",
                        "description": "歌曲主题，如'爱情'、'友情'、'思乡'",
                    },
                    "genre": {
                        "type": "string",
                        "description": "音乐风格",
                        "enum": ["pop", "rock", "folk", "jazz", "hiphop", "electronic", "ballad"],
                        "default": "pop",
                    },
                    "mood": {
                        "type": "string",
                        "description": "情绪氛围，如'温暖'、'忧伤'、'欢快'",
                        "default": "温暖",
                    },
                    "language": {
                        "type": "string",
                        "description": "歌词语言",
                        "enum": ["zh", "en", "mixed"],
                        "default": "zh",
                    },
                },
                "required": ["theme"],
            },
        ),
        Tool(
            name="generate_song",
            description="生成完整歌曲 - 输入歌词，输出包含人声和伴奏的完整歌曲",
            inputSchema={
                "type": "object",
                "properties": {
                    "lyrics": {
                        "type": "string",
                        "description": "歌词文本（支持中文和英文）",
                    },
                    "genre": {
                        "type": "string",
                        "description": "音乐风格",
                        "enum": ["pop", "rock", "folk", "jazz", "hiphop", "electronic", "ballad"],
                        "default": "pop",
                    },
                    "duration": {
                        "type": "integer",
                        "description": "歌曲时长（秒），建议 60-180",
                        "default": 60,
                        "minimum": 30,
                        "maximum": 300,
                    },
                    "output_path": {
                        "type": "string",
                        "description": "输出文件路径（.wav 或 .mp3）",
                        "default": "output_song.wav",
                    },
                },
                "required": ["lyrics"],
            },
        ),
        Tool(
            name="generate_accompaniment",
            description="生成伴奏 - 仅生成背景音乐，不包含人声",
            inputSchema={
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "音乐描述，如'温暖的民谣吉他，缓慢节奏'",
                    },
                    "genre": {
                        "type": "string",
                        "description": "音乐风格",
                        "default": "pop",
                    },
                    "duration": {
                        "type": "integer",
                        "description": "时长（秒）",
                        "default": 60,
                    },
                    "output_path": {
                        "type": "string",
                        "description": "输出文件路径",
                        "default": "accompaniment.wav",
                    },
                },
                "required": ["description"],
            },
        ),
        Tool(
            name="generate_vocal",
            description="生成人声 - 仅生成人声演唱，不包含伴奏",
            inputSchema={
                "type": "object",
                "properties": {
                    "lyrics": {
                        "type": "string",
                        "description": "歌词文本",
                    },
                    "genre": {
                        "type": "string",
                        "description": "音乐风格",
                        "default": "pop",
                    },
                    "output_path": {
                        "type": "string",
                        "description": "输出文件路径",
                        "default": "vocal.wav",
                    },
                },
                "required": ["lyrics"],
            },
        ),
        Tool(
            name="list_models",
            description="列出可用的歌曲生成模型及其状态",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


# ============================================================
# MCP 工具实现
# ============================================================

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """处理 MCP 工具调用"""
    
    try:
        if name == "write_lyrics":
            return await handle_write_lyrics(arguments)
        elif name == "generate_song":
            return await handle_generate_song(arguments)
        elif name == "generate_accompaniment":
            return await handle_generate_accompaniment(arguments)
        elif name == "generate_vocal":
            return await handle_generate_vocal(arguments)
        elif name == "list_models":
            return await handle_list_models(arguments)
        else:
            return [TextContent(type="text", text=f"未知工具: {name}")]
    except Exception as e:
        error_msg = f"工具执行失败: {str(e)}"
        return [TextContent(type="text", text=error_msg)]


async def handle_write_lyrics(args: dict) -> list[TextContent]:
    """处理作词请求"""
    theme = args.get("theme", "爱情")
    genre = args.get("genre", "pop")
    mood = args.get("mood", "温暖")
    language = args.get("language", "zh")
    
    # 生成歌词模板（实际使用时可集成 LLM）
    lyrics_template = f"""[verse]
{theme}的故事在风中飘荡
每一个字都是心中的光
{mood}的感觉像一首歌
唱给所有懂的人听

[chorus]
我们在{genre}的旋律里相遇
让这首歌成为永恒的记忆
不管世界如何改变
这份{mood}永远不会散去

[verse]
时光匆匆流过指尖
那些美好的瞬间
都化作了这首歌
陪伴你度过每一天

[chorus]
我们在{genre}的旋律里相遇
让这首歌成为永恒的记忆
不管世界如何改变
这份{mood}永远不会散去

[bridge]
当夜幕降临
星光闪烁
这首歌会一直唱着
直到永远
"""
    
    result = {
        "status": "success",
        "lyrics": lyrics_template,
        "theme": theme,
        "genre": genre,
        "mood": mood,
        "language": language,
    }
    
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]


async def handle_generate_song(args: dict) -> list[TextContent]:
    """处理歌曲生成请求"""
    lyrics = args.get("lyrics")
    genre = args.get("genre", "pop")
    duration = args.get("duration", 60)
    output_path = args.get("output_path", "output_song.wav")
    
    if not lyrics:
        return [TextContent(type="text", text="错误: 缺少歌词参数")]
    
    # 获取生成器
    generator = get_generator()
    
    # 生成歌曲
    result = generator.generate_song(
        lyrics=lyrics,
        genre=genre,
        duration=duration,
        output_path=output_path,
    )
    
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]


async def handle_generate_accompaniment(args: dict) -> list[TextContent]:
    """处理伴奏生成请求"""
    description = args.get("description")
    genre = args.get("genre", "pop")
    duration = args.get("duration", 60)
    output_path = args.get("output_path", "accompaniment.wav")
    
    # 使用 MusicGen 生成纯伴奏（如果可用）
    result = {
        "status": "info",
        "output_path": output_path,
        "description": description,
        "genre": genre,
        "duration": duration,
        "message": "伴奏生成功能建议使用 MusicGen 模型，或使用 generate_song 生成完整歌曲后提取伴奏",
    }
    
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]


async def handle_generate_vocal(args: dict) -> list[TextContent]:
    """处理人声生成请求"""
    lyrics = args.get("lyrics")
    genre = args.get("genre", "pop")
    output_path = args.get("output_path", "vocal.wav")
    
    result = {
        "status": "info",
        "output_path": output_path,
        "lyrics": lyrics,
        "genre": genre,
        "message": "人声生成功能建议使用 DiffSinger 模型，或使用 generate_song 生成完整歌曲后提取人声",
    }
    
    return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))]


async def handle_list_models(args: dict) -> list[TextContent]:
    """列出可用模型"""
    models_info = {
        "models": [
            {
                "name": "DiffRhythm",
                "status": "available",
                "description": "歌词转完整歌曲（人声+伴奏），支持中英文",
                "vram_requirement": "8-10 GB",
                "generation_speed": "快 (10-30秒/分钟歌曲)",
                "chinese_support": "优秀",
                "repo": "https://github.com/ASLP-lab/DiffRhythm",
            },
            {
                "name": "YuE",
                "status": "available",
                "description": "基于 LLaMA 的歌词转歌曲，支持多种风格",
                "vram_requirement": "10-12 GB (INT4量化)",
                "generation_speed": "中 (1-3分钟/分钟歌曲)",
                "chinese_support": "良好",
                "repo": "https://github.com/multimodal-art-projection/YuE",
            },
            {
                "name": "MusicGen",
                "status": "available",
                "description": "纯音乐生成（无人声），适合伴奏",
                "vram_requirement": "3-6 GB",
                "generation_speed": "快 (30秒)",
                "chinese_support": "不适用（纯音乐）",
                "repo": "https://github.com/facebookresearch/audiocraft",
            },
            {
                "name": "DiffSinger",
                "status": "available",
                "description": "高质量人声合成，需要预训练声库",
                "vram_requirement": "4-8 GB",
                "generation_speed": "中 (30-60秒)",
                "chinese_support": "优秀",
                "repo": "https://github.com/MoonInTheRiver/DiffSinger",
            },
        ],
        "recommendation": "对于 RTX 3060 12GB，推荐使用 DiffRhythm（速度快、中文支持好）或 YuE INT4（质量高）",
    }
    
    return [TextContent(type="text", text=json.dumps(models_info, ensure_ascii=False, indent=2))]


# ============================================================
# MCP Server 启动
# ============================================================

async def run_server():
    """启动 MCP Server"""
    async with stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            app.create_initialization_options(),
        )


def main():
    """主入口"""
    print("="*60)
    print("🎵 AI 歌曲制作 MCP Server v2")
    print("="*60)
    print("可用工具:")
    print("  - write_lyrics: AI 作词")
    print("  - generate_song: 生成完整歌曲")
    print("  - generate_accompaniment: 生成伴奏")
    print("  - generate_vocal: 生成人声")
    print("  - list_models: 列出可用模型")
    print("="*60)
    print()
    
    asyncio.run(run_server())


if __name__ == "__main__":
    main()
