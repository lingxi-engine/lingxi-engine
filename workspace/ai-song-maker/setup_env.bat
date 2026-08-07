@echo off
chcp 65001 >nul
echo ============================================
echo   AI Song Maker - Environment Setup
echo   Target: RTX 3060 12GB / 64GB RAM
echo ============================================
echo.

:: ---- Step 1: Create conda environment ----
echo [1/6] Creating conda environment (Python 3.10)...
call conda create -n ai-song python=3.10 -y
if %errorlevel% neq 0 (
    echo [ERROR] Failed to create conda env. Is conda installed?
    pause
    exit /b 1
)
call conda activate ai-song

:: ---- Step 2: PyTorch + CUDA ----
echo [2/6] Installing PyTorch with CUDA 12.1...
pip install torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cu121

:: ---- Step 3: Core ML dependencies ----
echo [3/6] Installing core ML dependencies...
pip install transformers>=4.40.0
pip install accelerate>=0.28.0
pip install diffusers>=0.27.0
pip install soundfile>=0.12.1
pip install librosa>=0.10.1
pip install "numpy<2.0"
pip install scipy>=1.11.0
pip install einops
pip install vocos
pip install omegaconf
pip install tqdm

:: ---- Step 4: MusicGen (audiocraft) ----
echo [4/6] Installing audiocraft (MusicGen)...
pip install audiocraft

:: ---- Step 5: Audio processing + utilities ----
echo [5/6] Installing audio processing tools...
pip install pydub>=0.25.1
pip install midiutil
pip install pypinyin
pip install edge-tts

:: ---- Step 6: MCP Server ----
echo [6/6] Installing MCP Server dependencies...
pip install fastapi>=0.110.0
pip install "uvicorn[standard]>=0.29.0"
pip install pydantic>=2.6.0

echo.
echo ============================================
echo   Setup complete!
echo   Activate: conda activate ai-song
echo   Run:      python pipeline.py
echo ============================================
pause
