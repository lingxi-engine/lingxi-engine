#!/bin/bash
# ==========================================
#   歌曲制作环境安装脚本 (Linux/Mac)
#   适配: RTX 3060 12GB / CUDA 12.x
# ==========================================

set -e

export HF_ENDPOINT=https://hf-mirror.com
echo "=========================================="
echo "  歌曲制作环境安装脚本 (Linux/Mac)"
echo "=========================================="
echo ""

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] 未检测到 Python3，请先安装"
    exit 1
fi

# 创建虚拟环境
echo "[1/6] 创建虚拟环境..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
echo ""

# 升级 pip
echo "[2/6] 升级 pip..."
pip install --upgrade pip
echo ""

# 安装 PyTorch
echo "[3/6] 安装 PyTorch + CUDA 12.4..."
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
echo ""

# 安装核心依赖
echo "[4/6] 安装 DiffRhythm 核心依赖..."
pip install diffusers transformers accelerate safetensors
echo ""

# 安装音频处理
echo "[5/6] 安装音频处理和工具库..."
pip install soundfile librosa scipy pydub jieba pypinyin tqdm numpy
echo ""

# 安装 MCP Server
echo "[6/6] 安装 MCP Server 依赖..."
pip install fastapi uvicorn httpx pydantic
echo ""

# 验证
echo "=========================================="
echo "  验证安装"
echo "=========================================="
python -c "
import torch
print(f'PyTorch: {torch.__version__}')
print(f'CUDA: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU: {torch.cuda.get_device_name(0)}')
import diffusers
print(f'Diffusers: {diffusers.__version__}')
print('ALL OK!')
"

echo ""
echo "=========================================="
echo "  安装完成！"
echo "  下一步:"
echo "  1. source venv/bin/activate"
echo "  2. python run_pipeline.py"
echo "  3. python mcp_server.py"
echo "=========================================="
