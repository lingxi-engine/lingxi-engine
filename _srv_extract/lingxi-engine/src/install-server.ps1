# coding: utf-8 | chcp 65001 | UTF-8 fix
chcp 65001 > $null
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Write-Host ""
Write-Host "  ==========================" -ForegroundColor Green
Write-Host "   Lingxi Engine v1.7.1"
Write-Host "   Install / Upgrade"
Write-Host "  ==========================" -ForegroundColor Green
Write-Host ""

Write-Host "  Searching Node.js..." -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  [X] Node.js not found" -ForegroundColor Red
    Write-Host "  Please install: https://nodejs.org (LTS)"
    pause
    exit 1
}
Write-Host "  [OK] Node.js $(node -v)" -ForegroundColor Green

$dir = "$env:USERPROFILE\lingxi-engine"
$up = Test-Path $dir
if ($up) {
    Write-Host "  [UPGRADE] $dir" -ForegroundColor Cyan
    Get-Process -Name "node","tsx" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $k = @("node_modules","data")
    Get-ChildItem $dir -Directory | Where-Object { $k -notcontains $_.Name } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $dir -File | Where-Object { $_.Name -ne ".env" } | Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host "  [OK] Cleaned, kept data + .env + node_modules" -ForegroundColor Green
} else {
    Write-Host "  [NEW] Fresh install -> $dir" -ForegroundColor Cyan
}

Write-Host "  Downloading..." -ForegroundColor Cyan
$url = "http://47.93.157.83:8080/public/lingxi-engine-v1.7.0.tar.gz"
$tmp = "$env:TEMP\lx.tar.gz"
try { Invoke-WebRequest -Uri $url -OutFile $tmp -ErrorAction Stop }
catch { Write-Host "  [X] Download: $_" -ForegroundColor Red; pause; exit 1 }

Write-Host "  Extracting..." -ForegroundColor Cyan
tar -xzf $tmp -C "$env:USERPROFILE"; Remove-Item $tmp
cd $dir

if (-not (Test-Path ".env")) {
    @"
DEEPSEEK_API_KEY=***
PORT=3456
"@ | Out-File .env -Encoding UTF8
    Write-Host "  [WARN] Edit .env to add API Key" -ForegroundColor Yellow
} else { Write-Host "  [OK] .env preserved" -ForegroundColor Green }

if (-not (Test-Path "$dir\node_modules")) {
    Write-Host "  npm install (may take a while)..." -ForegroundColor Cyan
    npm install --silent 2>&1 | Out-Null
    npm install puppeteer --silent 2>&1 | Out-Null
} else {
    Write-Host "  [OK] node_modules preserved" -ForegroundColor Green
}

Write-Host ""
Write-Host "  ==========================" -ForegroundColor Green
if ($up) { Write-Host "    [UPGRADE] Complete!" -ForegroundColor Green }
else { Write-Host "    [INSTALL] Complete!" -ForegroundColor Green }
Write-Host "    Dir: $dir"
Write-Host "    Run: cd $dir; npx tsx index.ts"
Write-Host "    URL: http://127.0.0.1:3456"
Write-Host "  ==========================" -ForegroundColor Green
Write-Host ""

$s = Read-Host "  Start now? (y/n)"
if ($s -eq "y") {
    Start-Job {
        Start-Sleep 4
        try { Invoke-WebRequest http://127.0.0.1:3456/api/health -UseBasicParsing -TimeoutSec 15 | Out-Null } catch {}
        Start-Process "http://127.0.0.1:3456"
    } | Out-Null
    npx tsx index.ts
}
