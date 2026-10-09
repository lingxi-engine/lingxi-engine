# LingXi Engine 一键重启（v2.0.31）
# 修复：以前启动成功后只打印 "Now go to browser and press Ctrl+F5"，
#       脚本自己从不调用 Start-Process，所以「重启后不弹页面」。
# 现在：服务就绪后自动打开 http://localhost:3456
$ErrorActionPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot

# 只杀 node.exe 中命令行同时包含 'lingxi-engine' 和 'index.ts' 的进程，绝不误伤其他程序
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'lingxi-engine' -and $_.CommandLine -match 'index\.ts' }

if ($targets) {
  foreach ($p in $targets) {
    Write-Host ("  [1/4] stopping old engine, PID " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force
  }
} else {
  Write-Host "  [1/4] no running engine found, skip stop"
}
Start-Sleep -Seconds 3

Write-Host "  [2/4] starting engine (new minimized window)..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = '/c cd /d "' + $repoRoot + '" && npm start'
$psi.WorkingDirectory = $repoRoot
$psi.WindowStyle = "Minimized"
$psi.UseShellExecute = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null

Write-Host "  [3/4] waiting for service (up to 40s)..."
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://localhost:3456/")
    $req.Timeout = 3000
    $req.Headers.Add("Accept-Encoding", "gzip")
    $resp = $req.GetResponse()
    if ($resp.StatusCode -eq 200) { $resp.Close(); $ok = $true; break }
    $resp.Close()
  } catch { }
}

if ($ok) {
  Write-Host ""
  Write-Host "  [4/4] service is up, opening browser..." -ForegroundColor Cyan
  # 关键修复点：这里以前完全没有，所以不会自动弹页面
  Start-Process "http://localhost:3456"
  Write-Host "  [OK] engine restarted, HTTP 200 with gzip verified, browser opened." -ForegroundColor Green
  Write-Host "  If the tab didn't come to front, press Ctrl + F5 to hard refresh." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "  [FAIL] service not ready in 40s." -ForegroundColor Red
  Write-Host "  Open the minimized LingXi window and check red errors." -ForegroundColor Red
}
