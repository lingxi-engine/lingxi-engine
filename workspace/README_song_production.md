# 🎵 AI 歌曲制作系统

本地 AI 歌曲生成解决方案，支持中文歌词转完整歌曲（人声+伴奏），集成灵犀引擎 MCP 工具。

## 📋 项目概述

**目标**: 在 RTX 3060 (12GB) 上实现端到端 AI 歌曲生成  
**核心模型**: DiffRhythm (歌词→完整歌曲)  
**备选模型**: YuE (INT4量化版)  
**语言支持**: 中文优先，支持英文

## 🚀 快速开始

### 1. 安装环境

```bash
# Windows
install_song_env.bat

# 或手动安装
conda create -n song_env python=3.10
conda activate song_env
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install diffusers transformers accelerate soundfile librosa scipy numpy pydub midiutil
pip install mcp[cli] fastapi uvicorn
git clone https://github.com/ASLP-lab/DiffRhythm.git
cd DiffRhythm && pip install -e . && cd ..
```

### 2. 测试环境

```bash
python test_song_env.py
```

### 3. 生成歌曲

```bash
# 使用默认歌词
python generate_song.py

# 指定歌词文件
python generate_song.py lyrics.txt --genre pop --duration 120

# 指定歌词文本
python generate_song.py "你的歌词内容" --genre folk
```

### 4. 启动 MCP Server

```bash
python song_mcp_server.py
```

## 📁 文件结构

```
workspace/
├── song_production_plan.md      # 项目执行计划
├── install_song_env.bat         # 环境安装脚本
├── test_song_env.py             # 环境测试脚本
├── generate_song.py             # 核心歌曲生成代码
├── song_mcp_server.py           # MCP Server 封装
├── README_song_production.md    # 本文档
├── quick_start.bat              # 快速启动脚本
└── lyrics_example.txt           # 示例歌词
```

## 🎯 MCP 工具接口

### 1. write_lyrics (AI 作词)

```json
{
  "theme": "爱情",
  "genre": "pop",
  "mood": "温暖",
  "language": "zh"
}
```

### 2. generate_song (生成完整歌曲)

```json
{
  "lyrics": "你的歌词文本...",
  "genre": "pop",
  "duration": 120,
  "output_path": "my_song.wav"
}
```

### 3. generate_accompaniment (生成伴奏)

```json
{
  "description": "温暖的民谣吉他",
  "genre": "folk",
  "duration": 60
}
```

### 4. generate_vocal (生成人声)

```json
{
  "lyrics": "歌词文本",
  "genre": "pop"
}
```

## 🔧 模型对比

| 模型 | 显存需求 | 中文支持 | 生成速度 | 音质 |
|------|----------|----------|----------|------|
| **DiffRhythm** | 8-10GB | ⭐⭐⭐⭐⭐ | 快 (10-30s) | 高 |
| **YuE (INT4)** | 10-12GB | ⭐⭐⭐⭐ | 中 (1-3min) | 高 |
| **MusicGen** | 3-6GB | ⭐⭐ | 快 (30s) | 中 (纯音乐) |

## ⚙️ 硬件要求

- **最低**: RTX 3060 12GB
- **推荐**: RTX 4070 12GB 或更高
- **内存**: 16GB+ RAM
- **存储**: 20GB+ (模型文件)

## 🎨 支持的音乐风格

- `pop` - 流行
- `rock` - 摇滚
- `folk` - 民谣
- `jazz` - 爵士
- `hiphop` - 嘻哈
- `electronic` - 电子
- `ballad` - 抒情

## 🐛 常见问题

### Q: 显存不足怎么办？
A: 尝试使用 YuE INT4 量化版本，或降低生成时长。

### Q: 中文咬字不清晰？
A: DiffRhythm 对中文支持最好，确保使用最新模型版本。

### Q: 生成速度慢？
A: 正常现象，RTX 3060 生成 60 秒歌曲约需 10-30 秒。

### Q: MCP Server 无法启动？
A: 确保已安装 `mcp[cli]` 包，并检查 Python 版本 >= 3.10。

## 📊 验收标准

- ✅ 环境无报错运行
- ✅ 输入中文歌词，输出完整歌曲（WAV/MP3）
- ✅ 人声咬字清晰，无明显机械音
- ✅ 伴奏与人声音量平衡
- ✅ MCP Server 可被灵犀引擎调用
- ✅ 生成时长 < 30 秒（60秒歌曲）

## 🔗 相关链接

- [DiffRhythm GitHub](https://github.com/ASLP-lab/DiffRhythm)
- [YuE GitHub](https://github.com/multimodal-art-projection/YuE)
- [DiffSinger](https://github.com/MoonInTheRiver/DiffSinger)
- [灵犀引擎项目](../)

## 📝 更新日志

### v0.1.0 (2026-08-07)
- 初始版本
- 完成环境搭建脚本
- 实现核心歌曲生成代码
- 封装 MCP Server 接口
- 支持 DiffRhythm 和 YuE 模型
