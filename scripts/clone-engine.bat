@echo off
REM v1.5.0: 灵犀引擎克隆脚本 — 单机多引擎
REM 用法: clone-engine.bat <新引擎名> <端口号>
REM 示例: clone-engine.bat worker-1 3457

set NAME=%1
set PORT=%2

if "%NAME%"=="" (
  echo 用法: clone-engine.bat ^<名称^> ^<端口^>
  echo 示例: clone-engine.bat worker-1 3457
  exit /b 1
)

if "%PORT%"=="" (
  echo 用法: clone-engine.bat ^<名称^> ^<端口^>
  echo 示例: clone-engine.bat worker-1 3457
  exit /b 1
)

set TARGET=%cd%\lingxi-engine-%NAME%

if exist "%TARGET%" (
  echo 目标已存在: %TARGET%
  echo 请先删除或换个名称
  exit /b 1
)

echo 克隆引擎到: %TARGET%
xcopy /E /I /Q "%cd%\lingxi-engine" "%TARGET%"

echo 配置新实例...
(
echo PORT=%PORT%
echo DATA_DIR=data-%NAME%
echo WORKSPACE_DIR=workspace-%NAME%
) > "%TARGET%\.env"

echo.
echo ✅ 新引擎实例已创建
echo    名称: %NAME%
echo    端口: %PORT%
echo    路径: %TARGET%
echo.
echo 启动: cd %TARGET% ^&^& npm start
echo 或: npx tsx index.ts --port=%PORT%
