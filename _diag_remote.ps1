$ErrorActionPreference = 'Continue'
$key = 'C:\Users\Administrator\.ssh\lingxi_deploy'
$remote = 'root@47.93.157.83'

ssh -i $key -o StrictHostKeyChecking=no $remote "sleep 5; echo '--- 端口监听 ---'; ss -tlnp | grep 3456; echo '--- curl 重试 ---'; curl -s -o /dev/null -w 'HTTP %{http_code}, %{size_download} bytes\n' http://127.0.0.1:3456/ ; echo '--- pm2 状态 ---'; pm2 list | grep lingxi; echo '--- 最近日志 ---'; pm2 logs lingxi --lines 25 --nostream 2>&1 | tail -30" 2>&1 | ForEach-Object { Write-Host $_ }
