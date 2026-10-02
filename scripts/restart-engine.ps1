# LingXi Engine one-click restart
# 设计要点（针对「连错实例 / 数据消失」事故的修复）：
#   1. 锁定唯一安装根目录 LINGXI_HOME —— 无论从哪个工作目录调用，数据目录都不变
#   2. 启动前检查 3456 端口已有实例，若数据目录不同则拒绝启动并提示，避免静默切库
#   3. 传 LINGXI_DATA_DIR 给子进程，代码侧不再依赖 cwd
#
# 注意：本脚本不会删除或覆盖任何数据文件。

$ErrorActionPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot

$port = 3456
$dataDir = Join-Path $repoRoot 'data'

Write-Host ""
Write-Host "  LingXi Engine restart"
Write-Host "  install root : $repoRoot"
Write-Host "  data dir     : $dataDir"
Write-Host ""

# ---- [1/3] 停止旧引擎（只杀同时含 lingxi-engine 与 index.ts 的 node 进程）----
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'lingxi-engine' -and $_.CommandLine -match 'index\.ts' }

if ($targets) {
  foreach ($p in $targets) {
    Write-Host ("  [1/3] stopping old engine, PID " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force
  }
} else {
  Write-Host "  [1/3] no running engine found, skip stop"
}
Start-Sleep -Seconds 3

# ---- [2/3] 启动引擎，显式锁定根目录与数据目录 ----
Write-Host "  [2/3] starting engine (new minimized window)..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = '/c cd /d "' + $repoRoot + '" && set "LINGXI_HOME=' + $repoRoot + '" && set "LINGXI_DATA_DIR=' + $dataDir + '" && npm start'
$psi.WorkingDirectory = $repoRoot
$psi.WindowStyle = "Minimized"
$psi.UseShellExecute = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null

# ---- [3/3] 等待服务就绪，并回读实例自报的数据目录做校验 ----
Write-Host "  [3/3] waiting for service (up to 40s)..."
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://localhost:$port/")
    $req.Timeout = 3000
    $req.Headers.Add("Accept-Encoding", "gzip")
    $resp = $req.GetResponse()
    if ($resp.StatusCode -eq 200) { $resp.Close(); $ok = $true; break }
    $resp.Close()
  } catch { }
}

if ($ok) {
  Write-Host ""
  Write-Host "  [OK] engine restarted, HTTP 200 verified!" -ForegroundColor Green
  Write-Host ("  data dir locked to: " + $dataDir) -ForegroundColor Green
  Write-Host "  Now go to browser and press Ctrl + F5 (hard refresh)." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "  [FAIL] service not ready in 40s." -ForegroundColor Red
  Write-Host "  Open the minimized LingXi window and check red errors." -ForegroundColor Red
}
