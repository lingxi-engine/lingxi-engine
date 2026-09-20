@echo off
cd /d C:\Users\Administrator\lingxi-engine
set DEFAULT_MODEL=deepseek-flash
set TOOL_MODEL=deepseek-flash
set REPLY_MODEL=deepseek-flash
start "" /b cmd /c "node --require C:\Users\Administrator\lingxi-engine\node_modules\tsx\dist\preflight.cjs --import file:///C:/Users/Administrator/lingxi-engine/node_modules/tsx/dist/loader.mjs index.ts --port 3621 --data-dir data-bench14 > C:\Users\Administrator\lingxi-engine\workspace\bench\logs\bench3621.log 2>&1"
