$ErrorActionPreference = 'Continue'
$key = 'C:\Users\Administrator\.ssh\lingxi_deploy'
$remote = 'root@47.93.157.83'
$local = 'C:\Users\Administrator\lingxi-engine\_deploy_remote_204404.sh'

Write-Host '=== 上传部署脚本 ==='
scp -i $key -o StrictHostKeyChecking=no $local "${remote}:/opt/lingxi-release/_deploy_204404.sh"

Write-Host '=== 执行远程部署 ==='
ssh -i $key -o StrictHostKeyChecking=no $remote "chmod +x /opt/lingxi-release/_deploy_204404.sh && bash /opt/lingxi-release/_deploy_204404.sh" 2>&1 | ForEach-Object { Write-Host $_ }
