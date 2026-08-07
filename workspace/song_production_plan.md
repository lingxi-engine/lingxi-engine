# 歌曲制作完整执行计划

## 目标
在 RTX 3060 (12GB) 上搭建本地 AI 歌曲生成流程，支持中文歌词转完整歌曲（人声+伴奏），并封装为 MCP Server。

## 技术栈选型

### 核心模型：DiffRhythm
- **来源**: https://github.com/ASLP-lab/DiffRhythm
- **架构**: Latent Diffusion Model
- **能力**: 歌词 → 完整歌曲（人声+伴奏）
- **语言**: 中文、英文原生支持
- **时长**: 最长 4:45
- **显存**: 预估 8-10GB（RTX 3060 12GB 可运行）

### 备选模型：YuE (INT4量化)
- **来源**: https://github.com/multimodal-art-projection/YuE
- **架构**: LLaMA-based (8B参数)
- **量化**: INT4 (bitsandbytes) 压缩到 ~10GB
- **能力**: 歌词 → 完整歌曲
- **语言**: 多语言支持

## 执行步骤

### Phase 1: 环境搭建
1. 创建 conda 环境
2. 安装 PyTorch + CUDA
3. 安装 DiffRhythm 依赖
4. 下载预训练模型

### Phase 2: 核心代码开发
1. 编写 DiffRhythm 推理脚本
2. 测试中文歌词生成
3. 优化参数（采样步数、温度等）

### Phase 3: MCP Server 封装
1. 设计 MCP 工具接口
2. 实现作词工具（可选，用 LLM）
3. 实现编曲/渲染工具（DiffRhythm）
4. 测试 MCP 调用

### Phase 4: 验收测试
1. 端到端生成测试
2. 音质评估
3. 性能基准测试

## 验收标准
- ✅ 环境无报错运行
- ✅ 输入中文歌词，输出完整歌曲（WAV/MP3）
- ✅ 人声咬字清晰，无明显机械音
- ✅ 伴奏与人声音量平衡
- ✅ MCP Server 可被灵犀引擎调用
