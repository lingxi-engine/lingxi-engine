$ErrorActionPreference = 'Continue'
$key = 'C:\Users\Administrator\.ssh\lingxi_deploy'
$remote = 'root@47.93.157.83'

ssh -i $key -o StrictHostKeyChecking=no $remote "echo '--- /api/agents ---'; curl -s http://127.0.0.1:3456/api/agents | head -c 300; echo ''; echo '--- app.js 新功能 ---'; curl -s 'http://127.0.0.1:3456/js/app.js?v=20260825c' | grep -c '_agentNameLine'; echo '--- index.html 版本号 ---'; curl -s http://127.0.0.1:3456/ | grep -o 'app.js?v=[0-9a-z]*'; echo '--- 群成员/多选 ---'; curl -s 'http://127.0.0.1:3456/js/app.js?v=20260825c' | grep -c 'showAgentPicker'" 2>&1 | ForEach-Object { Write-Host $_ }
