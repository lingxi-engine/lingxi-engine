# 🐛 Bug检查报告 - AI歌曲制作系统
## 审查日期：2026-08-09 | 审查范围：workspace 全部 194 个文件
---

## 🔴 P0 — 阻塞性/严重崩溃 (5个)

### BUG-001: API密钥硬编码泄露
- **文件**: `probe_engine.py:41`, `probe_engine2.py:16`
- **严重程度**: 🔴 阻塞性 - 安全漏洞
- **描述**: 
  - `probe_engine.py` 第41行硬编码完整DeepSeek API密钥: `sk-65d529832f8c4cdb86fa198df004dcab`
  - `probe_engine2.py` 第16行硬编码管理员token: `08b550ca5b73f587f9bf354c8f8eab9f`
- **复现步骤**: 
  1. 打开 `probe_engine.py` 查看第41行
  2. 打开 `probe_engine2.py` 查看第16行
  3. 密钥和token以明文形式暴露，任何人可读取并滥用
- **日志/证据**: 
  ```
  probe_engine.py:41 → FULL_KEY = "sk-65d529832f8c4cdb86fa198df004dcab"
  probe_engine2.py:16 → ADMIN_TOKEN = "08b550ca5b73f587f9bf354c8f8eab9f"
  ```

---

### BUG-002: YuE模型静音输出（占位代码未替换）
- **文件**: `generate_song_v2.py:237-243`, `song_maker/generate_song_v2.py`, 根目录 `generate_song.py`
- **严重程度**: 🔴 严重 - 功能完全不可用
- **描述**: `YuEGenerator._decode_audio_tokens()` 方法返回全零静音数组。当YuE模型的`decode_audio`属性不存在时，回退到该方法，但该方法生成的是60秒的纯静音（`np.zeros(duration_samples)`）。
- **复现步骤**:
  1. 切换到YuE模型: `python generate_song_v2.py --model yue "歌词文本"`
  2. 模型加载后调用 `_decode_audio_tokens`
  3. 生成的音频文件是60秒静音
- **代码证据**:
  ```python
  # generate_song_v2.py:237-243
  def _decode_audio_tokens(self, outputs):
      logger.warning("使用简化的音频解码，音质可能不佳")
      duration_samples = 44100 * 60  # 60秒
      audio = np.zeros(duration_samples, dtype=np.float32)  # ← 全零静音!
      return audio
  ```

---

### BUG-003: 硬编码绝对路径导致跨环境崩溃
- **文件**: `music/run_diffrhythm.py:8`, `music/run_diffrhythm_95.py:5`, `music/make_vocal.py:13`, `music/make_vocal_v2.py:15`, `music/daqiwancheng.py` 等多处
- **严重程度**: 🔴 阻塞性 - 项目完全不可移植
- **描述**: 多个核心文件中硬编码了 `C:\Users\Administrator\lingxi-engine\` 绝对路径。一旦环境用户名不同或目录结构变化，所有脚本直接崩溃。
- **复现步骤**:
  1. 在非 `Administrator` 用户的机器上运行 `music/run_diffrhythm.py`
  2. 直接抛出 `FileNotFoundError`
- **具体位置**:
  ```
  music/run_diffrhythm.py:8 → os.chdir(r"C:\Users\Administrator\lingxi-engine\diffrhythm-local")
  music/run_diffrhythm_95.py:5 → 同上
  music/make_vocal.py:13 → os.chdir(r"C:\Users\Administrator\lingxi-engine\workspace\music")
  music/make_vocal_v2.py:15 → 同上
  ```

---

### BUG-004: 高通滤波器系数错误导致音频失真
- **文件**: `music/synth_engine.py:45-53`
- **严重程度**: 🔴 严重 - 所有使用此高通滤波的音频都会失真
- **描述**: `highpass()` 函数使用了错误的滤波器系数。一阶高通差分方程为 `y[n] = a*y[n-1] + a*(x[n] - x[n-1])`，其中 `a = e^(-2π*cutoff/SR)`。但代码中 `alpha = 1 - e^(-2π*cutoff/SR)`，属于低通滤波器的alpha定义。这导致截止频率偏移且幅频响应不正确。
- **复现步骤**:
  1. 调用 `hihat()` 函数（内部会调用 `highpass` 以7000Hz截止）
  2. 实际截止频率远低于7000Hz
  3. 鼓组镲片音色发闷
- **代码证据**:
  ```python
  def highpass(x, cutoff):
      alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff / SR)  # ← 应为 exp(-2π*cutoff/SR)
      ...
  ```

---

### BUG-005: DiffRhythm模型下载网络超时
- **文件**: `music/infer_log.txt`
- **严重程度**: 🔴 阻塞性 - 无法获取模型权重
- **描述**: 从 `huggingface.co` 下载 `cfm_model.pt` 时反复超时（WinError 10060），重试5次全部失败。使用 `hf-mirror.com` 镜像可能也需要进一步确认可用性。
- **复现步骤**:
  1. 运行 `run_diffrhythm.py` 或 `run_infer.py`
  2. 观察 `hf_hub_download` 请求 `ASLP-lab/DiffRhythm-1_2/cfm_model.pt`
  3. 5次重试后抛出 `LocalEntryNotFoundError`
- **日志证据**: `infer_log.txt` 完整记录了5次重试失败的过程

---

## 🟠 P1 — 功能性缺陷 (7个)

### BUG-006: MCP Server write_lyrics 返回硬编码模板
- **文件**: `song_mcp_server.py:209-235`, `song_maker/mcp_server_v2.py:209-235`
- **严重程度**: 🟠 功能缺陷
- **描述**: MCP Server的 `write_lyrics` 工具不调用任何LLM，直接返回一段固定的模板歌词。无论用户输入什么主题、风格、情绪，返回的歌词完全相同（只做了变量替换）。
- **复现步骤**:
  1. 首次调用 write_lyrics(theme="春天", mood="欢快")
  2. 再次调用 write_lyrics(theme="离别", mood="悲伤")
  3. 两次返回的歌词除了theme/mood变量外结构完全一致
- **证据**: `lyrics_template = f"""[verse]\n{theme}的故事在风中飘荡\n每一个字都是心中的光\n{mood}的感觉像一首歌\n...`

---

### BUG-007: generate_accompaniment 和 generate_vocal 为空壳
- **文件**: `song_mcp_server.py:256-289`, `song_maker/mcp_server_v2.py:275-308`
- **严重程度**: 🟠 功能缺陷 - 声明了功能但未实现
- **描述**: 两个MCP Server的 `generate_accompaniment` 和 `generate_vocal` 工具直接返回 `"message": "xx功能待实现/建议使用..."` 的占位信息，未实际调用任何模型。
- **复现步骤**:
  1. 调用 generate_accompaniment 工具
  2. 返回 `{"status": "info", "message": "伴奏生成功能待实现..."}`
- **影响**: 文档声称支持这4个工具，实际只有2个可用

---

### BUG-008: 代码大量重复（违反DRY原则）
- **文件**: `music/song.py`, `music/daqiwancheng.py`, `music/make_daqiwancheng.py`, `music/make_dqwc.py`, `music/lofi_dream.py`
- **严重程度**: 🟠 功能缺陷 - 维护性极差
- **描述**: 5个文件各自完整复制了鼓组、贝斯、钢琴、弦乐垫、琶音、主旋律的构建函数，以及和弦进行、混音逻辑。总重复代码量估计超过800行。修改一个参数需要在所有文件中同步。
- **复现步骤**:
  1. 对比 `song.py:build_drums()` 和 `daqiwancheng.py:build_drums()`
  2. 对比 `make_daqiwancheng.py:make_drums()` 和 `make_dqwc.py` 中的鼓组代码
  3. 四个版本几乎完全相同

---

### BUG-009: bitsandbytes 依赖缺失（INT4量化无法工作）
- **文件**: `song_maker/requirements.txt:33-34`
- **严重程度**: 🟠 功能缺陷
- **描述**: `requirements.txt` 中 `bitsandbytes` 被注释 (`# bitsandbytes>=0.42.0`)，但 `generate_song_v2.py` 和 `generate_song.py` 中的 `YuEGenerator` 依赖 `BitsAndBytesConfig` 实现INT4量化。Windows上安装 bitsandbytes 本身也极其困难。
- **复现步骤**:
  1. pip install -r requirements.txt
  2. 运行 YuE 模型加载 → `ImportError: cannot import name 'BitsAndBytesConfig'`

---

### BUG-010: 和弦定义与旋律音高不匹配
- **文件**: `music/make_vocal.py`, `music/make_vocal_v2.py`, `music/make_vocal_v3.py`, `music/daqiwancheng.py`
- **严重程度**: 🟠 功能缺陷 - 音乐和声错误
- **描述**: 
  - `daqiwancheng.py` 定义D大调和弦（D, Bm, G, A），但副歌3升调到E大调（E, C#m, A, B）
  - `make_vocal.py` 人声旋律中的音符使用了 `midi_to_freq` 但基准计算可能有误
  - `make_vocal_v3.py` 的旋律定义与 `daqiwancheng.py` 的Lead旋律不一致
- **复现步骤**:
  1. 分别运行 daqiwancheng.py 和 make_vocal_v3.py
  2. 在同一小节（如bar 64-71），伴奏是E大调但人声旋律走向不同
  3. 合成后出现不和谐音

---

### BUG-011: MCP Server 导入路径硬编码不匹配
- **文件**: `song_mcp_server.py:20`
- **严重程度**: 🟠 功能缺陷
- **描述**: `song_mcp_server.py` 使用 `from generate_song import SongGenerator` 导入根目录的 `generate_song.py`，但核心的 `SongGenerator` 位于 `song_maker/generate_song_v2.py`。同时 `song_maker/mcp_server_v2.py` 使用 `from generate_song_v2 import SongGenerator` 但需要先 `cd` 到正确目录才能导入。
- **复现步骤**:
  1. 在根目录运行 `python song_mcp_server.py`
  2. 如果 `song_maker` 不在 `sys.path` 中，导入失败

---

### BUG-012: lyrics_writer.py 初始化时立即创建 httpx.Client
- **文件**: `song_maker/lyrics_writer.py:24`
- **严重程度**: 🟠 功能缺陷
- **描述**: `LyricsWriter.__init__()` 在 `__init__` 中就创建了 `httpx.Client(timeout=60.0)`。如果灵犀引擎未运行，类实例化不会报错，但调用 `write_lyrics()` 时如果连接失败，client不会自动重连/重建。
- **复现步骤**:
  1. 在灵犀引擎未启动时实例化 LyricsWriter
  2. 启动引擎后调用 write_lyrics → 仍可能使用旧的连接状态

---

## 🟡 P2 — UI/体验类 (6个)

### BUG-013: 采样率不一致
- **文件**: `ai-song-maker/config.py:31` vs 其他所有文件
- **严重程度**: 🟡 体验
- **描述**: `ai-song-maker/config.py` 定义 `SAMPLE_RATE = 32000`，而所有其他模块使用 44100Hz。混音时会产生采样率不匹配。

### BUG-014: README引用不存在的文件
- **文件**: `README_song_production.md`
- **严重程度**: 🟡 体验
- **描述**: README引用了 `lyrics_example.txt`、`run_pipeline.py`、`mcp_server.py` 等文件，但这些文件在项目中不存在。

### BUG-015: MCP端口配置冲突风险
- **文件**: `ai-song-maker/config.py:50`, `song_maker/config.py:89`
- **严重程度**: 🟡 体验
- **描述**: ai-song-maker MCP端口设为8900，song_maker MCP端口设为8765。两个MCP server同时运行可能冲突，且文档中注明"避免与灵犀引擎冲突"但未验证。

### BUG-016: 歌词模板无变化
- **文件**: `song_mcp_server.py`, `song_maker/mcp_server_v2.py`
- **严重程度**: 🟡 体验
- **描述**: 用户输入任何主题都得到相同结构的模板歌词，体验极差。

### BUG-017: 错误消息中英文混杂
- **文件**: 多处
- **严重程度**: 🟡 体验
- **描述**: 项目中同时存在中文和英文的错误消息/日志，如 `"错误: 缺少歌词参数"` 和 `"ImportError: 无法导入 DiffRhythm 模块"`，对中文用户不友好。

### BUG-018: make_vocal.py 使用了不安全的 asyncio.run() 嵌套
- **文件**: `music/make_vocal.py:126`
- **严重程度**: 🟡 体验 - 可能在特定环境下崩溃
- **描述**: `synth_singing()` 函数内部循环调用 `asyncio.run(gen_tts(...))`，而外部函数 `main()` 也调用了 `asyncio.run(main())`（实际上这里是 if __name__ == "__main__"），在已运行的事件循环中嵌套 `asyncio.run()` 会抛出 `RuntimeError`。

---

## 📊 统计汇总

| 严重程度 | 数量 | 占比 |
|----------|------|------|
| 🔴 P0 阻塞性/严重崩溃 | 5 | 28% |
| 🟠 P1 功能性缺陷 | 7 | 39% |
| 🟡 P2 UI/体验类 | 6 | 33% |
| **合计** | **18** | 100% |

## 🔥 最高优先级修复建议

1. **立即删除** probe_engine.py 和 probe_engine2.py 中的硬编码密钥（安全风险）
2. 将所有绝对路径 `C:\Users\Administrator\lingxi-engine\` 改为相对路径或用 `Path(__file__).parent`
3. 修复 synth_engine.py 高通滤波器系数
4. 实现 YuEGenerator 的真正音频解码（替换静音占位）
