# 🎵 AI 歌曲制作 - 模型选型对比

## 硬件环境
- **GPU**: RTX 3060 12GB
- **内存**: 64GB RAM
- **存储**: 需要 ~20GB 用于模型文件

## 模型对比矩阵

| 维度 | DiffRhythm | YuE (INT4) | YuE (FP16) | MusicGen | DiffSinger |
|------|-----------|------------|------------|----------|------------|
| **类型** | 扩散模型 | LLM+音频 | LLM+音频 | 扩散模型 | 扩散模型 |
| **输出** | 完整歌曲(人声+伴奏) | 完整歌曲 | 完整歌曲 | 纯音乐 | 纯人声 |
| **参数量** | ~1.3B | ~7B | ~7B | 300M-1.5B | ~100M |
| **显存需求** | 8-10 GB | 10-12 GB | 14-16 GB | 3-8 GB | 4-8 GB |
| **中文支持** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ (纯音乐) | ⭐⭐⭐⭐⭐ |
| **生成速度** | 10-30秒/分钟 | 1-3分钟/分钟 | 3-5分钟/分钟 | 30秒/30秒 | 30-60秒/分钟 |
| **音质** | Demo级 | Demo级 | 高质量 | 高质量 | 高质量 |
| **易用性** | 中 | 中 | 低 | 高 | 低(需声库) |
| **适合场景** | 快速出片 | 精细制作 | 专业制作 | BGM/伴奏 | 虚拟歌手 |

## 推荐方案

### 🥇 首选: DiffRhythm
**理由**:
- 专为歌词转歌曲设计，一步到位输出人声+伴奏
- 中文咬字清晰，支持中英文混合
- 生成速度快（10秒可生成完整歌曲）
- 显存占用 8-10GB，RTX 3060 12GB 完全够用
- 最长支持 4分45秒 的完整歌曲

**安装**:
```bash
git clone https://github.com/ASLP-lab/DiffRhythm.git
cd DiffRhythm && pip install -e .
```

**推理**:
```bash
python inference.py --lyrics_path lyrics.txt --genre_prompt "pop" --duration 120 --output song.wav
```

### 🥈 备选: YuE (INT4 量化)
**理由**:
- 基于 LLaMA 架构，生成质量高
- 支持多种音乐风格
- INT4 量化后可在 12GB 显存运行
- 生成速度较慢，适合挂机跑批

**安装**:
```bash
git clone https://github.com/multimodal-art-projection/YuE.git
cd YuE && pip install -r requirements.txt
pip install bitsandbytes  # INT4 量化支持
```

### 🥉 辅助: MusicGen (伴奏生成)
**理由**:
- 显存占用低（3-6GB）
- 生成速度快
- 适合生成纯伴奏/BGM
- 可与 DiffSinger 人声合成配合使用

**安装**:
```bash
pip install audiocraft
```

## 架构设计

```
输入: 主题/歌词文本
         │
         ▼
┌─────────────────┐
│  write_lyrics   │  ← LLM 作词（可选）
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ generate_song   │  ← DiffRhythm 核心推理
│  (人声+伴奏)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  后处理/混音     │  ← 音量平衡、降噪
└────────┬────────┘
         │
         ▼
    输出: WAV/MP3
```

## MCP Server 集成

灵犀引擎通过 MCP 协议调用以下工具:

1. **write_lyrics** - AI 作词
2. **generate_song** - 生成完整歌曲
3. **generate_accompaniment** - 生成伴奏
4. **generate_vocal** - 生成人声
5. **list_models** - 列出可用模型

## 性能预估 (RTX 3060 12GB)

| 任务 | 预计耗时 | 显存峰值 |
|------|----------|----------|
| 加载 DiffRhythm | 30-60秒 | 8-10 GB |
| 生成 60秒歌曲 | 10-30秒 | 8-10 GB |
| 生成 180秒歌曲 | 30-90秒 | 8-10 GB |
| 加载 YuE INT4 | 60-120秒 | 10-12 GB |
| 生成 60秒歌曲 (YuE) | 1-3分钟 | 10-12 GB |

## 注意事项

1. **首次运行**会自动下载模型权重（DiffRhythm ~5GB, YuE ~14GB）
2. 使用 `HF_ENDPOINT=https://hf-mirror.com` 加速国内下载
3. 生成期间 GPU 占用率高，但 CPU 和内存压力小，可做其他事
4. 建议生成 60-120 秒的歌曲以获得最佳质量/速度平衡
