# 🎵 歌曲制作系统 - 最终部署指南

## 📋 前置条件确认

- ✅ Python 3.10+
- ✅ CUDA 12.4+
- ✅ RTX 3060 12GB (或更高)
- ✅ 64GB 内存
- ✅ 50GB 磁盘空间

---

## 🎯 一键部署（推荐）

### Windows 用户

```bash
# 进入工作目录
cd C:\Users\Administrator\lingxi-engine\workspace\song_maker

# 执行一键安装脚本
install_v2.bat
```

这个脚本会自动完成：
1. 克隆 DiffRhythm 仓库
2. 安装所有 Python 依赖
3. 下载模型权重（~5-8GB，耗时约10-30分钟）
4. 运行环境测试

### Linux/Mac 用户

```bash
cd /path/to/lingxi-engine/workspace/song_maker
chmod +x install.sh
./install.sh
```

---

## 🔧 手动部署（如需自定义）

### 步骤 1：克隆 DiffRhythm

```bash
cd song_maker
git clone https://github.com/ASLP-lab/DiffRhythm.git
cd DiffRhythm
pip install -e .
cd ..
```

### 步骤 2：安装 espeak-ng（Windows 必需）

1. 下载：https://github.com/espeak-ng/espeak-ng/releases
2. 安装到默认路径
3. 验证：`espeak-ng --version`

### 步骤 3：安装 Python 依赖

```bash
pip install -r requirements.txt
```

### 步骤 4：下载模型权重

```bash
# 创建模型目录
mkdir models
cd models

# 下载 DiffRhythm 人声模型
git clone https://huggingface.co/ASLP-lab/DiffRhythm
# 或使用 huggingface-cli
pip install huggingface_hub
huggingface-cli download ASLP-lab/DiffRhythm --local-dir ./DiffRhythm

# 下载 MusicGen 伴奏模型
huggingface-cli download facebook/musicgen-small --local-dir ./musicgen-small

cd ..
```

### 步骤 5：验证环境

```bash
python test_env_v2.py
```

期望输出：
```
✅ Python 版本: 3.10.x
✅ PyTorch: 2.6.0+cu124
✅ CUDA 可用: True
✅ GPU: NVIDIA GeForce RTX 3060
✅ DiffRhythm 已安装
✅ espeak-ng 可用
✅ 模型文件存在
```

---

## 🎤 生成第一首歌

### 方式 1：命令行直接生成

```bash
# 基础用法
python generate_song_v2.py "你的歌词内容" --output my_first_song.wav

# 完整参数
python generate_song_v2.py "你的歌词" \
  --genre pop \
  --tempo 120 \
  --duration 60 \
  --vocal-model ./models/DiffRhythm \
  --accomp-model ./models/musicgen-small \
  --output my_song.wav
```

### 方式 2：使用配置文件

编辑 `config.py`，然后运行：

```bash
python generate_song_v2.py --config
```

### 方式 3：AI 作词 + 生成

```bash
# 先让 AI 写歌词
python lyrics_writer.py --theme "青春" --style "流行" --output lyrics.txt

# 查看生成的歌词
cat lyrics.txt

# 用歌词生成歌曲
python generate_song_v2.py --lyrics-file lyrics.txt --output youth_song.wav
```

---

## 🔌 集成到灵犀引擎

### 步骤 1：启动 MCP Server

```bash
cd song_maker
python mcp_server_v2.py
```

MCP Server 会监听 `localhost:3001`（可在 config.py 中修改）

### 步骤 2：在灵犀引擎中注册 MCP Server

在灵犀引擎的配置文件中添加：

```json
{
  "mcpServers": {
    "song-maker": {
      "command": "python",
      "args": ["C:/Users/Administrator/lingxi-engine/workspace/song_maker/mcp_server_v2.py"],
      "env": {}
    }
  }
}
```

### 步骤 3：测试 MCP 工具

在灵犀引擎对话中尝试：

```
请帮我写一首关于春天的歌词
```

```
用这段歌词生成一首歌：[粘贴歌词]
```

---

## 📊 MCP Server 提供的工具

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `write_lyrics` | AI 作词 | theme, style, structure |
| `generate_song` | 完整歌曲生成 | lyrics, genre, tempo, duration |
| `generate_vocal` | 仅生成人声 | lyrics, melody_prompt |
| `generate_accompaniment` | 仅生成伴奏 | style, duration, tempo |
| `list_models` | 列出可用模型 | - |

---

## 🐛 常见问题

### Q1: CUDA out of memory

**解决**：在 `config.py` 中降低参数：
```python
BATCH_SIZE = 1
MAX_DURATION = 30  # 缩短时长
```

### Q2: espeak-ng not found

**解决**：确保 espeak-ng 在 PATH 中，或在 config.py 中指定路径：
```python
ESPEAK_PATH = "C:/Program Files/eSpeak NG/espeak-ng.exe"
```

### Q3: 模型下载失败

**解决**：使用镜像源：
```bash
set HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download ASLP-lab/DiffRhythm --local-dir ./models/DiffRhythm
```

### Q4: 生成速度慢

**正常现象**：RTX 3060 生成 60 秒歌曲约需 5-15 分钟。可在 config.py 中调整：
```python
INFERENCE_STEPS = 20  # 降低步数（牺牲质量）
```

---

## 📈 性能预期（RTX 3060 12GB）

| 任务 | 耗时 | 显存占用 |
|------|------|----------|
| 30秒歌曲 | 3-5分钟 | ~8GB |
| 60秒歌曲 | 8-15分钟 | ~10GB |
| 120秒歌曲 | 20-30分钟 | ~11GB |

---

## ✅ 验收检查清单

- [ ] `test_env_v2.py` 全部通过
- [ ] 成功生成至少一首 WAV 文件
- [ ] 人声咬字清晰（中文无明显机械音）
- [ ] 伴奏与人声音量平衡
- [ ] MCP Server 启动无报错
- [ ] 灵犀引擎可调用 MCP 工具

---

## 📞 下一步

完成上述步骤后，回复我：
- "环境测试通过" → 我帮你调试生成参数
- "生成成功但音质不佳" → 我帮你调优
- "MCP 集成失败" → 我帮你排查

---

**所有代码已就绪，等待你在本地 GPU 上执行！** 🚀
