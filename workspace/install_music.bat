@echo off
chcp 65001
echo ==========================================
echo 音乐生成环境安装脚本
echo ==========================================
echo.

echo [1/4] 设置 Hugging Face 镜像（加速下载）...
set HF_ENDPOINT=https://hf-mirror.com
echo 镜像已设置: %HF_ENDPOINT%
echo.

echo [2/4] 安装 PyTorch（CUDA 11.8 版本）...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
if %errorlevel% neq 0 (
    echo PyTorch 安装失败，尝试 CPU 版本...
    pip install torch torchvision torchaudio
)
echo.

echo [3/4] 安装 AudioCraft...
pip install audiocraft
if %errorlevel% neq 0 (
    echo AudioCraft 安装失败，尝试从 GitHub 安装...
    pip install git+https://github.com/facebookresearch/audiocraft.git
)
echo.

echo [4/4] 安装其他依赖...
pip install scipy soundfile
echo.

echo ==========================================
echo 安装完成！
echo 现在运行: python generate.py
echo ==========================================
pause
