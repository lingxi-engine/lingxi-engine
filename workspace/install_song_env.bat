@echo off
chcp 65001
echo ==========================================
echo AI 歌曲制作环境安装脚本
echo 目标模型: DiffRhythm (歌词转完整歌曲)
echo 硬件要求: RTX 3060 12GB
echo ==========================================
echo.

echo [1/6] 设置 Hugging Face 镜像（加速下载）...
set HF_ENDPOINT=https://hf-mirror.com
echo 镜像已设置: %HF_ENDPOINT%
echo.

echo [2/6] 创建 Python 虚拟环境...
python -m venv song_env
if %errorlevel% neq 0 (
    echo 虚拟环境创建失败，请检查 Python 安装
    pause
    exit /b 1
)
call song_env\Scripts\activate.bat
echo 虚拟环境已激活
echo.

echo [3/6] 升级 pip...
python -m pip install --upgrade pip
echo.

echo [4/6] 安装 PyTorch（CUDA 12.4 版本）...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
if %errorlevel% neq 0 (
    echo PyTorch CUDA 12.4 安装失败，尝试 CUDA 11.8...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
)
echo.

echo [5/6] 安装 DiffRhythm 及依赖...
pip install diffusers transformers accelerate
pip install soundfile librosa scipy numpy
pip install pydub midiutil
pip install mcp[cli] fastapi uvicorn
echo.

echo [6/6] 克隆 DiffRhythm 仓库...
if not exist "DiffRhythm" (
    git clone https://github.com/ASLP-lab/DiffRhythm.git
    cd DiffRhythm
    pip install -e .
    cd ..
) else (
    echo DiffRhythm 目录已存在，跳过克隆
)
echo.

echo ==========================================
echo 环境安装完成！
echo.
echo 下一步操作:
echo 1. 激活环境: song_env\Scripts\activate.bat
echo 2. 运行测试: python test_song_env.py
echo 3. 生成歌曲: python generate_song.py "你的歌词"
echo ==========================================
pause
