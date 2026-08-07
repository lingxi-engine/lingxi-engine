@echo off
chcp 65001 >nul
echo ==========================================
echo   AI 歌曲制作系统 - 完整安装脚本
echo   适配: RTX 3060 12GB / CUDA 12.x
echo ==========================================
echo.

set HF_ENDPOINT=https://hf-mirror.com
echo [INFO] HuggingFace 镜像: %HF_ENDPOINT%
echo.

REM 检查 Python
python --version 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

REM 创建虚拟环境
echo [1/8] 创建虚拟环境...
if not exist "venv" (
    python -m venv venv
    echo       虚拟环境已创建
) else (
    echo       虚拟环境已存在，跳过
)
call venv\Scripts\activate.bat
echo.

REM 升级 pip
echo [2/8] 升级 pip...
python -m pip install --upgrade pip
echo.

REM 安装 PyTorch
echo [3/8] 安装 PyTorch + CUDA 12.4...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
if %errorlevel% neq 0 (
    echo [WARN] CUDA 12.4 失败，尝试 CUDA 11.8...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
)
echo.

REM 安装核心依赖
echo [4/8] 安装核心依赖...
pip install diffusers transformers accelerate safetensors soundfile librosa scipy pydub jieba pypinyin tqdm numpy
echo.

REM 安装 MCP Server 依赖
echo [5/8] 安装 MCP Server 依赖...
pip install mcp[cli] fastapi uvicorn httpx pydantic
echo.

REM 克隆 DiffRhythm
echo [6/8] 克隆 DiffRhythm 仓库...
if not exist "DiffRhythm" (
    git clone https://github.com/ASLP-lab/DiffRhythm.git
    cd DiffRhythm
    pip install -e .
    cd ..
    echo       DiffRhythm 已安装
) else (
    echo       DiffRhythm 已存在，跳过
)
echo.

REM 克隆 YuE
echo [7/8] 克隆 YuE 仓库...
if not exist "YuE" (
    git clone https://github.com/multimodal-art-projection/YuE.git
    cd YuE
    pip install -r requirements.txt
    cd ..
    echo       YuE 已安装
) else (
    echo       YuE 已存在，跳过
)
echo.

REM 验证安装
echo [8/8] 验证安装...
python -c "import torch; print(f'PyTorch: {torch.__version__}'); print(f'CUDA: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"N/A\"}'); import diffusers; print(f'Diffusers: {diffusers.__version__}'); import transformers; print(f'Transformers: {transformers.__version__}'); print('ALL OK!')"
echo.

echo ==========================================
echo   安装完成！
echo.
echo   下一步:
echo   1. 激活环境: venv\Scripts\activate.bat
echo   2. 测试环境: python test_env.py
echo   3. 生成歌曲: python generate_song_v2.py
echo   4. 启动MCP:  python mcp_server_v2.py
echo ==========================================
pause
