$ErrorActionPreference = 'Stop'
$key = 'C:\Users\Administrator\.ssh\lingxi_deploy'
$remote = 'root@47.93.157.83'

Write-Host '=== 远程哈希校验 ==='
$r = ssh -i $key -o StrictHostKeyChecking=no $remote "cd /opt/lingxi-release && sha256sum lingxi-engine-2.0.12-20260824-204404.tar.gz lingxi-python-engine-2.0.12-20260824-204404.tar.gz && ls -la"
$r | ForEach-Object { Write-Host $_ }
