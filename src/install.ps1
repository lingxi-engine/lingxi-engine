# LingXi Engine - Windows Installer (PowerShell)
# Version: auto (generated at install time)
# Usage: iwr -useb http://your-download-server:8080/install.ps1 | iex

try { Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction Stop } catch {}
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$InstallDir = Join-Path $env:USERPROFILE "lingxi-engine"
$TarballUrl = "http://your-download-server:8080/public/lingxi-engine.tar.gz"
$INSTALL_VERSION = (Get-Date).ToString("v2026.M.d-H.mm")

function W-OK($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function W-Info($m)  { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function W-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function W-Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

# --- 1. Node.js ---
W-Info "Checking Node.js..."
$needNode = $true
try {
    $nv = [int]((node -v) -replace 'v','' -replace '\..*','')
    if ($nv -ge 18) { W-OK "Node.js $(node -v) found"; $needNode = $false }
    else { W-Warn "Node.js too old ($(node -v)), need 18+" }
} catch { W-Info "Node.js not found" }

if ($needNode) {
    W-Info "Installing Node.js 20..."
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $url = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-$arch.msi"
    $msi = "$env:TEMP\node-setup.msi"
    W-Info "Downloading Node.js 20.18.1 ($arch)..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
        W-Info "Installing (may need admin)..."
        Start-Process msiexec.exe -ArgumentList "/i",$msi,"/quiet","/norestart" -Wait -NoNewWindow
        Remove-Item $msi -Force -EA SilentlyContinue
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
        W-OK "Node.js $(node -v) installed"
    } catch {
        W-Fail "Node.js install failed. Please install manually: https://nodejs.org"
    }
}

# --- 2. Download ---
W-Info "Downloading LingXi Engine..."
$tb = Join-Path $env:TEMP "lingxi-engine.tar.gz"
Invoke-WebRequest -Uri $TarballUrl -OutFile $tb -UseBasicParsing
$sz = [math]::Round((Get-Item $tb).Length/1KB)
W-OK "Downloaded ($sz KB)"

# --- 3. Extract ---
W-Info "Stopping existing engine (if running)..."
try {
    # 杀掉占用 3456 端口的进程
    $portConn = netstat -ano 2>$null | Select-String ":3456\s" | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -ne '0' } | Sort-Object -Unique
    foreach ($pid in $portConn) {
        try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue; W-Info "Killed PID $pid" } catch {}
    }
    # 兜底：杀掉 lingxi-engine 目录下的 node 进程
    Get-Process -Name "node","tsx" -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -like "*lingxi-engine*" -or $_.MainWindowTitle -like "*lingxi*" } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
} catch {}
W-Info "Extracting to $InstallDir ..."
if (Test-Path $InstallDir) {
    W-Warn "Old install exists. New files will overwrite."
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$extractTmp = Join-Path $env:TEMP "lingxi-extract-$(Get-Random)"
New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null
$extractOK = $false
try {
    # 优先使用完整路径调用 tar.exe（避免 irm|iex 环境 PATH 问题）
    $tarExe = "$env:SystemRoot\System32\tar.exe"
    if (-not (Test-Path $tarExe)) { $tarExe = "tar" }
    $proc = Start-Process -FilePath $tarExe -ArgumentList "-xzf","`"$tb`"","-C","`"$extractTmp`"" -Wait -NoNewWindow -PassThru -RedirectStandardError "$extractTmp\_err.txt"
    if ($proc.ExitCode -ne 0) {
        $errMsg = if (Test-Path "$extractTmp\_err.txt") { Get-Content "$extractTmp\_err.txt" -Raw } else { "exit code $($proc.ExitCode)" }
        W-Warn "tar failed: $errMsg"
    } else {
        $extractOK = $true
    }
} catch {
    W-Warn "tar exception: $($_.Exception.Message)"
}
if (-not $extractOK) {
    # 备用方案：.NET GZipStream 解压
    W-Info "Trying .NET fallback extraction..."
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $gzStream = [System.IO.Compression.GZipStream]::new([System.IO.File]::OpenRead($tb), [System.IO.Compression.CompressionMode]::Decompress)
        $tarPath = "$extractTmp\archive.tar"
        $outStream = [System.IO.File]::Create($tarPath)
        $gzStream.CopyTo($outStream)
        $outStream.Close(); $gzStream.Close()
        # 用 tar 解包 tar（不用 gzip）
        $tarExe2 = "$env:SystemRoot\System32\tar.exe"
        if (Test-Path $tarExe2) {
            Start-Process -FilePath $tarExe2 -ArgumentList "-xf","`"$tarPath`"","-C","`"$extractTmp`"" -Wait -NoNewWindow
        }
        Remove-Item $tarPath -Force -EA SilentlyContinue
        $extractOK = $true
    } catch {
        W-Fail "Extract failed: $($_.Exception.Message). Need Windows 10+ with tar.exe"
    }
}
$innerDir = Join-Path $extractTmp "lingxi-engine"
if (Test-Path $innerDir) {
    Get-ChildItem $innerDir -Force | ForEach-Object { Copy-Item $_.FullName $InstallDir -Recurse -Force }
    W-OK "Extracted"
} else {
    Get-ChildItem $extractTmp -Force -Exclude "_err.txt" | ForEach-Object { Copy-Item $_.FullName $InstallDir -Recurse -Force }
    W-OK "Extracted (flat)"
}
Remove-Item $extractTmp -Recurse -Force -EA SilentlyContinue
Remove-Item $tb -Force -EA SilentlyContinue

New-Item -ItemType Directory -Path (Join-Path $InstallDir "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir "uploads") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir "workspace") -Force | Out-Null
# v1.9.7: 强制沙箱关闭（旧安装可能残留 enabled:true，必须覆盖）
[System.IO.File]::WriteAllText((Join-Path $InstallDir "data\sandbox-config.json"), '{"enabled":false}', [System.Text.Encoding]::UTF8)
W-OK "Directories created (sandbox: OFF)"

# --- 4. npm install ---
W-Info "Installing dependencies..."
Push-Location $InstallDir
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    # npm install — 用 --loglevel=error 抦制 warn，避免 PowerShell NativeCommandError 红字
    $npmResult = & npm install --omit=optional --loglevel=error 2>&1
    if ($LASTEXITCODE -ne 0) {
        W-Warn "First attempt had issues, retrying..."
        & npm install --omit=optional --loglevel=error 2>&1 | Out-Null
    }
    W-OK "Dependencies installed"
} catch {
    W-Warn "npm install error, retrying..."
    & npm install --omit=optional --loglevel=error 2>&1 | Out-Null
    W-OK "Dependencies installed (retry)"
} finally {
    $ErrorActionPreference = $prevEAP
}
# esbuild 需要平台二进制包，--omit=optional 会跳过它，这里补装
& npm install @esbuild/win32-x64 --no-save --loglevel=error 2>&1 | Out-Null
W-OK "Dependencies installed"
Pop-Location

# --- 5. .env ---
$envFile = Join-Path $InstallDir ".env"
$ollamaOK = $false
if (-not (Test-Path $envFile)) {
    $envContent = @"
# ==========================================
#  LingXi Engine - AI Provider Configuration
# ==========================================
#  Choose ONE of these options to get AI working:
#
#  Option A: Local Ollama (free, recommended)
#    Install: https://ollama.com
#    Then run: ollama run qwen2.5:7b
#    (Engine auto-detects Ollama on startup)
#
#  Option B: Cloud API Key
#    NVIDIA (free tier): https://build.nvidia.com
#    OpenAI: https://platform.openai.com/api-keys
#    DeepSeek: https://platform.deepseek.com
#    (Paste your key below and restart)
#
#  Tip: You can also add providers in the Settings panel inside the app!
# ==========================================

# --- Auto-detected (no key needed) ---
OLLAMA_BASE_URL=http://localhost:11434/v1

# --- Cloud API Keys (pick one) ---
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
# OPENAI_API_KEY=
# DEEPSEEK_API_KEY=

# --- Model name used when you send a message ---
# DeepSeek: deepseek-chat / deepseek-reasoner
# NVIDIA NIM: qwen/qwen3-next-80b-a3b-instruct / meta/llama-4-maverick-17b-128e-instruct
# Ollama: qwen2.5:7b / llama3 / ...
DEFAULT_MODEL=deepseek-chat

# --- Multi-model collaboration (optional) ---
TOOL_MODEL=
REPLY_MODEL=

# --- Security (REQUIRED - change these!) ---
# Generate a random JWT secret: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=

# Admin API token (set a strong password)
ADMIN_TOKEN=

# --- Mesh Platform (cross-network social) ---
MESH_PLATFORM_URL=
MESH_TOKEN=change-me-to-a-strong-secret

# --- Server port ---
PORT=3456
"@
    [System.IO.File]::WriteAllText($envFile, $envContent, [System.Text.Encoding]::UTF8)
    W-OK ".env created"
} else {
    W-OK ".env already exists"
}

# --- 6. Check Ollama ---
W-Info "Checking Ollama..."
$ollamaOK = $false
try {
    $ollama = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3
    $models = ($ollama.Content | ConvertFrom-Json).models
    if ($models.Count -gt 0) {
        W-OK "Ollama running with $($models.Count) models - Ready to go!"
        $ollamaOK = $true
    } else {
        W-Warn "Ollama running but no models. Run: ollama pull qwen2.5:7b"
    }
} catch {
    W-Warn "Ollama not running or not installed"
}

# --- 7. Done ---
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  LingXi Engine installed!" -ForegroundColor White
Write-Host "  Version: $INSTALL_VERSION" -ForegroundColor Gray
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""

if ($ollamaOK) {
    Write-Host "  [Ready] Start the engine:" -ForegroundColor Green
    Write-Host "    cd $InstallDir" -ForegroundColor Gray
    Write-Host "    npx tsx index.ts" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Open: http://localhost:3456" -ForegroundColor White
    Write-Host ""
    Write-Host "  Ollama models loaded automatically!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  [Security] Must configure before use:" -ForegroundColor Red
    Write-Host "    Edit: $envFile" -ForegroundColor Gray
    Write-Host "    Set: JWT_SECRET=***" -ForegroundColor Gray
    Write-Host "    Set: ADMIN_TOKEN=***" -ForegroundColor Gray
} else {
    Write-Host "  [Action Required] You need an AI model to use the engine:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Local (fast & free):" -ForegroundColor White
    Write-Host "    1) Install: https://ollama.com" -ForegroundColor Gray
    Write-Host "    2) Download: ollama run qwen2.5:7b" -ForegroundColor Gray
    Write-Host "    3) Then: cd $InstallDir; npx tsx index.ts" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Cloud (no download needed):" -ForegroundColor White
    Write-Host "    1) Get free key: https://build.nvidia.com" -ForegroundColor Gray
    Write-Host "    2) Edit: $envFile" -ForegroundColor Gray
    Write-Host "       Set: NVIDIA_API_KEY=***" -ForegroundColor Gray
    Write-Host "    3) Then: cd $InstallDir; npx tsx index.ts" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Or add provider in-app: Settings -> Add Provider" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  [Security] Must configure before use:" -ForegroundColor Red
    Write-Host "    Set: JWT_SECRET=***" -ForegroundColor Gray
    Write-Host "    Set: ADMIN_TOKEN=***" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  Open: http://localhost:3456" -ForegroundColor White
Write-Host ""

# --- 8. Auto-start ---
$startNow = Read-Host "  Start now? (y/n)"
if ($startNow -eq 'y' -or $startNow -eq 'Y') {
    # 再次确保旧进程已杀掉
    try {
        $portConn = netstat -ano 2>$null | Select-String ":3456\s" | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -ne '0' } | Sort-Object -Unique
        foreach ($p in $portConn) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }
        Start-Sleep -Seconds 1
    } catch {}
    W-Info "Starting engine..."
    Start-Job {
        Start-Sleep 5
        try { Invoke-WebRequest http://127.0.0.1:3456/api/health -UseBasicParsing -TimeoutSec 15 | Out-Null } catch {}
        Start-Process "http://127.0.0.1:3456"
    } | Out-Null
    Push-Location $InstallDir
    npx tsx index.ts
    Pop-Location
}
