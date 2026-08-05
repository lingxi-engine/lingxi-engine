@echo off
chcp 65001 >nul
setlocal

echo.
echo ═══════════════════════════════════════
echo   灵犀引擎 一键安装
echo ═══════════════════════════════════════
echo.

REM ── 检查 Node.js ──
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [X] 未检测到 Node.js，请先安装 Node.js 18+ 
  echo     下载地址：https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [✓] Node.js %NODE_VER%

REM ── 检查 npm ──
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [X] 未检测到 npm
  pause
  exit /b 1
)
echo [✓] npm 已就绪

echo.
echo ── 安装依赖 ──
call npm install
if %ERRORLEVEL% neq 0 (
  echo [X] 依赖安装失败
  pause
  exit /b 1
)
echo [✓] 依赖安装完成

REM ── 创建 .env（如果不存在）──
if not exist ".env" (
  if exist ".env.example" (
    copy .env.example .env >nul
    echo [✓] 已从 .env.example 创建 .env
    echo     请编辑 .env 填写你的 API Key
    echo.
    echo     至少需要配置一个 AI Provider：
    echo       - NVIDIA_API_KEY（推荐，免费申请：https://build.nvidia.com）
    echo       - 或 OPENAI_API_KEY
    echo       - 或本地运行 Ollama
  ) else (
    echo [!] 未找到 .env.example，请手动创建 .env
  )
) else (
  echo [✓] .env 已存在
)

REM ── 创建数据目录 ──
if not exist "data" mkdir data
if not exist "uploads" mkdir uploads
echo [✓] 数据目录已创建

echo.
echo ═══════════════════════════════════════
echo   安装完成！
echo ═══════════════════════════════════════
echo.
echo   启动：npm start
echo   开发：npm run dev
echo   访问：http://localhost:3456
echo.
echo   首次使用请编辑 .env 配置 API Key
echo.
pause