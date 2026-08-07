@echo off
chcp 65001 >nul
echo ==========================================
echo   歌曲制作环境安装脚本 (Windows)
echo   适配: RTX 3060 12GB / CUDA 12.x
echo ==========================================
echo.

REM 设置 HuggingFace 镜像加速
set HF_ENDPOINT=https://hf-mirror.com
echo [INFO] HuggingFace 镜像: %HF_ENDPOINT%
echo.

REM 检查 Python 版本
python --version 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Python，请先安装 Python 3.10+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 创建虚拟环境
echo [1/6] 创建虚拟环境...
if not exist "venv" (
    python -m venv venv
    echo       虚拟环境已创建
) else (
    echo       虚拟环境已存在，跳过
)
call venv\Scripts\activate.bat
echo.

REM 升级 pip
echo [2/6] 升级 pip...
python -m pip install --upgrade pip
echo.

REM 安装 PyTorch (CUDA 12.4)
echo [3/6] 安装 PyTorch + CUDA 12.4...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
if %errorlevel% neq 0 (
    echo [WARN] CUDA 12.4 安装失败，尝试 CUDA 11.8...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
)
echo.

REM 安装 DiffRhythm 核心依赖
echo [4/6] 安装 DiffRhythm 核心依赖...
pip install diffusers transformers accelerate safetensors
echo.

REM 安装音频处理和工具库
echo [5/6] 安装音频处理和工具库...
pip install soundfile librosa scipy pydub jieba pypinyin tqdm numpy
echo.

REM 安装 MCP Server 依赖
echo [6/6] 安装 MCP Server 依赖...
pip install fastapi uvicorn httpx pydantic
echo.

REM 验证安装
echo ==========================================
echo   验证安装
echo ==========================================
python -c "import torch; print(f'PyTorch: {torch.__version__}'); print(f'CUDA: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); import diffusers; print(f'Diffusers: {diffusers.__version__}'); import transformers; print(f'Transformers: {transformers.__version__}'); print('ALL OK!')"
echo.

echo ==========================================
echo   安装完成！
echo.
echo   下一步:
echo   1. 激活环境: venv\Scripts\activate.bat
echo   2. 生成歌曲: python run_pipeline.py
echo   3. 启动MCP:  python mcp_server.py
echo ==========================================
pause
