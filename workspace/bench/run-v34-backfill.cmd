@echo off
cd /d C:\Users\Administrator\lingxi-engine\workspace
echo [START-G4L3] %DATE% %TIME% > bench\logs\v34-g4l3.log
node bench\adapters\ws-adapter.cjs --layers L3 --group G4 --only L3-001,L3-002,L3-003,L3-004,L3-005,L3-006,L3-007,L3-008,L3-009,L3-010 --bench-model deepseek-flash --url "ws://localhost:3621/ws?id=bench-runner" --out bench/results/v34-G4L3 >> bench\logs\v34-g4l3.log 2>&1
echo [DONE-G4L3] %DATE% %TIME% >> bench\logs\v34-g4l3.log
echo [START-L2001] %DATE% %TIME% > bench\logs\v34-l2001.log
node bench\adapters\ws-adapter.cjs --layers L2 --group G4 --only L2-001 --bench-model deepseek-flash --url "ws://localhost:3621/ws?id=bench-runner" --out bench/results/v34-L2001 >> bench\logs\v34-l2001.log 2>&1
echo [DONE-L2001] %DATE% %TIME% >> bench\logs\v34-l2001.log
