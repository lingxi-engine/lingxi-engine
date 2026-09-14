# 灵犀引擎一键重启脚本（2026-09-14 重部署善后）
# 只杀命令行里同时含 lingxi-engine 和 index.ts 的 node 进程，不误伤其他程序
$ErrorActionPreference = 'SilentlyContinue'
# v2.0.19: 仓库根目录从脚本自身位置推导，其它电脑部署到任意路径都能用（旧版硬编码了本机路径）
$repoRoot = Split-Path -Parent $PSScriptRoot
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

Write-Host "  [2/3] starting engine (new minimized window)..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c cd /d "$repoRoot"" && npm start"
$psi.WindowStyle = "Minimized"
$psi.UseShellExecute = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null

Write-Host "  [3/3] waiting for service (up to 40s)..."
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
  Write-Host "  [OK] engine restarted, HTTP 200 with gzip verified!" -ForegroundColor Green
  Write-Host "  Now go to browser and press Ctrl + F5 (hard refresh)." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "  [FAIL] service not ready in 40s." -ForegroundColor Red
  Write-Host "  Open the minimized LingXi window and check red errors." -ForegroundColor Red
}
