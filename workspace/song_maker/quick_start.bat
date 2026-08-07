@echo off
chcp 65001 >nul
echo ==========================================
echo   AI 歌曲制作 - 快速启动
echo ==========================================
echo.

REM 激活虚拟环境
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
    echo ✅ 虚拟环境已激活
) else (
    echo ❌ 虚拟环境不存在，请先运行 install_v2.bat
    pause
    exit /b 1
)
echo.

REM 设置 HuggingFace 镜像
set HF_ENDPOINT=https://hf-mirror.com
echo [INFO] HuggingFace 镜像: %HF_ENDPOINT%
echo.

REM 选择操作
echo 请选择操作:
echo   1. 测试环境
echo   2. 生成歌曲 (默认歌词)
echo   3. 生成歌曲 (自定义歌词文件)
echo   4. 启动 MCP Server
echo   5. 退出
echo.

set /p choice=请输入选项 (1-5): 

if "%choice%"=="1" (
    echo.
    echo 🔍 测试环境...
    python test_env_v2.py
) else if "%choice%"=="2" (
    echo.
    echo 🎵 生成歌曲 (默认歌词)...
    python generate_song_v2.py --genre pop --duration 60
) else if "%choice%"=="3" (
    echo.
    set /p lyrics_file=请输入歌词文件路径: 
    python generate_song_v2.py "%lyrics_file%" --genre pop --duration 120
) else if "%choice%"=="4" (
    echo.
    echo 🔌 启动 MCP Server...
    python mcp_server_v2.py
) else if "%choice%"=="5" (
    echo.
    echo 退出
    exit /b 0
) else (
    echo.
    echo 无效选项
)

echo.
pause
