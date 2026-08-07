# 🎵 歌曲制作技术栈 - 最终确认

## 硬件约束
- GPU: RTX 3060 (12GB VRAM)
- RAM: 64GB
- 接受慢速推理（10-30分钟/首）

## 核心模型选型对比

| 维度 | DiffRhythm ⭐推荐 | YuE (INT4) | DiffSinger |
|------|-------------------|-------------|------------|
| 架构 | Latent Diffusion | LLaMA-based 8B | Diffusion |
| 输入 | 歌词文本 | 歌词文本 | MIDI+歌词 |
| 输出 | 完整歌曲(人声+伴奏) | 完整歌曲 | 仅人声 |
| 中文支持 | ✅ 原生 | ✅ 支持 | ✅ 社区声库 |
| 最长时长 | 4:45 | ~2min | 取决于输入 |
| 显存占用 | ~8-10GB | ~10-12GB | ~4GB |
| 推理速度 | ~10秒(快) | ~15-30分钟 | ~5分钟 |
| 端到端 | ✅ 一键生成 | ✅ 一键生成 | ❌ 需手动编曲 |
| 成熟度 | 2025.3发布 | 2025.1发布 | 2022年 |

## 最终方案

### 主方案：DiffRhythm
- 歌词 → 完整歌曲（人声+伴奏），一步到位
- 显存 ~8-10GB，RTX 3060 12GB 可运行
- 中文原生支持，咬字清晰
- 生成速度极快（~10秒/首）

### 备选方案：YuE (INT4量化)
- 如果 DiffRhythm 效果不满意，切换到 YuE
- 需要 bitsandbytes 做 INT4 量化
- 显存 ~10-12GB，刚好塞进 3060

### 辅助工具
- **作词**: 调用灵犀引擎 LLM（已有能力）
- **混音/母带**: pydub + scipy 简单后处理
- **格式转换**: ffmpeg

## 文件结构
```
song_maker/
├── install.bat          # 环境安装脚本
├── install.sh           # Linux/Mac 安装脚本
├── requirements.txt     # Python 依赖
├── config.py            # 配置文件
├── generate_song.py     # 核心推理脚本
├── mcp_server.py        # MCP Server 封装
├── lyrics_writer.py     # AI作词模块
├── post_process.py      # 后处理（混音/格式转换）
├── run_pipeline.py      # 端到端主控脚本
└── output/              # 输出目录
```
