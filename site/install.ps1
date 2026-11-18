# LingXi Engine - Windows Installer (PowerShell 5.1+)
# Usage (Administrator PowerShell):
#   irm https://www.lingxi-engine.com/install.ps1 | iex
# Two-step alternative (lets you control startup):
#   Invoke-WebRequest -Uri https://www.lingxi-engine.com/install.ps1 -OutFile install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# IMPORTANT: this file is intentionally ASCII-only. Windows PowerShell 5.1 decodes
# `irm` responses without a charset as Latin-1, so any non-ASCII byte turns to mojibake.
# Keep it ASCII and do NOT add a BOM: pure ASCII is a fixed point under Latin-1, UTF-8 and ANSI decoding alike.

try { Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction Stop } catch {}
$ErrorActionPreference = "Stop"
# PS 5.1 renders a progress bar for Invoke-WebRequest that makes downloads 10-50x slower
# (a 30MB Node MSI can look "frozen" for minutes). Silence it.
$ProgressPreference = "SilentlyContinue"
# Older Win10 builds default to TLS 1.0/1.1 which the server rejects. Force TLS 1.2+.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

# When run via `irm | iex`, $PSCommandPath is EMPTY. In that mode `exit 1` would close
# the user's whole console window (they never see the error) - throw instead.
$script:IexMode = [string]::IsNullOrEmpty($PSCommandPath)
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

$InstallDir = Join-Path $env:USERPROFILE "lingxi-engine"
# Tarball source: production URL by default; override with $env:LINGXI_TARBALL_URL if self-hosting
$TarballUrl = if ($env:LINGXI_TARBALL_URL) { $env:LINGXI_TARBALL_URL } else { "https://www.lingxi-engine.com/public/lingxi-engine.tar.gz" }
$INSTALL_VERSION = (Get-Date).ToString("'v'yyyy.M.d-H.mm")

function W-OK($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function W-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function W-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function W-Fail($m) {
    Write-Host "[FAIL] $m" -ForegroundColor Red
    if ($script:IexMode) { throw $m } else { exit 1 }
}

# --- 1. Node.js ---
W-Info "Checking Node.js..."
$needNode = $true
try {
    $nv = [int]((node -v) -replace 'v','' -replace '\..*','')
    if ($nv -ge 18) { W-OK "Node.js $(node -v) found"; $needNode = $false }
    else { W-Warn "Node.js too old ($(node -v)), need 18+" }
} catch { W-Info "Node.js not found" }

if ($needNode) {
    if (-not $isAdmin) {
        W-Fail "Node.js 18+ is required and the MSI installer needs Administrator rights. Right-click PowerShell -> 'Run as administrator', then run the install command again. Or install Node.js manually from https://nodejs.org and re-run."
    }
    W-Info "Installing Node.js 22 LTS..."
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $urls = @(
        "https://cdn.npmmirror.com/binaries/node/v22.16.0/node-v22.16.0-$arch.msi",
        "https://nodejs.org/dist/v22.16.0/node-v22.16.0-$arch.msi"
    )
    $msi = "$env:TEMP\node-setup.msi"
    W-Info "Downloading Node.js 22.16.0 ($arch)..."
    try {
        $downloaded = $false
        foreach ($u in $urls) {
            try { Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing -TimeoutSec 600; $downloaded = $true; break }
            catch { W-Warn "Download failed: $u, trying next..." }
        }
        if (-not $downloaded) { throw "All Node.js download sources failed" }
        W-Info "Installing (silent MSI)..."
        $mp = Start-Process msiexec.exe -ArgumentList "/i","`"$msi`"","/quiet","/norestart" -Wait -NoNewWindow -PassThru
        Remove-Item $msi -Force -EA SilentlyContinue
        # 0 = success, 3010 = success but reboot recommended
        if ($mp.ExitCode -ne 0 -and $mp.ExitCode -ne 3010) {
            throw "msiexec exit code $($mp.ExitCode)"
        }
        $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
        $nodeNow = $null
        try { $nodeNow = (& node -v) } catch {}
        if (-not $nodeNow) { throw "node still not on PATH after install" }
        W-OK "Node.js $nodeNow installed"
    } catch {
        W-Fail "Node.js install failed ($($_.Exception.Message)). Install manually from https://nodejs.org (LTS, 18+), open a NEW PowerShell window, then re-run this installer."
    }
}

# --- 2. Download ---
W-Info "Downloading LingXi Engine..."
$tb = Join-Path $env:TEMP "lingxi-engine.tar.gz"
try {
    Invoke-WebRequest -Uri $TarballUrl -OutFile $tb -UseBasicParsing -TimeoutSec 300
} catch {
    try { Invoke-WebRequest -Uri $TarballUrl -OutFile $tb -UseBasicParsing -TimeoutSec 300 }
    catch { W-Fail "Cannot download $TarballUrl ($($_.Exception.Message)). Check your network/proxy. If the server returned 502/503, wait a minute and retry." }
}
# Guard against HTML error pages saved as .tar.gz (proxy interception, 502 bodies, etc.)
if (-not (Test-Path $tb) -or (Get-Item $tb).Length -lt 1MB) {
    W-Fail "Downloaded file is missing or suspiciously small - the server likely returned an error page. Retry in a few minutes."
}
$fsCheck = [System.IO.File]::OpenRead($tb)
$magic1 = $fsCheck.ReadByte(); $magic2 = $fsCheck.ReadByte()
$fsCheck.Close()
if ($magic1 -ne 0x1F -or $magic2 -ne 0x8B) {
    Remove-Item $tb -Force -EA SilentlyContinue
    W-Fail "Downloaded file is not a gzip archive (HTML error page?). URL: $TarballUrl"
}
$sz = [math]::Round((Get-Item $tb).Length/1KB)
W-OK "Downloaded ($sz KB)"

# --- 3. Extract ---
W-Info "Stopping existing engine (if running)..."
try {
    # 1) If PM2 manages the engine, stop+delete it first (autorestart would respawn killed processes)
    $pm2Cmd = $null
    if (Get-Command pm2 -ErrorAction SilentlyContinue) { $pm2Cmd = "pm2" }
    elseif (Test-Path (Join-Path $InstallDir "node_modules\.bin\pm2.cmd")) { $pm2Cmd = Join-Path $InstallDir "node_modules\.bin\pm2.cmd" }
    if ($pm2Cmd) {
        try { & $pm2Cmd stop lingxi 2>&1 | Out-Null; W-Info "PM2 stopped 'lingxi'" } catch {}
        try { & $pm2Cmd delete lingxi 2>&1 | Out-Null } catch {}
    }
    # 2) Kill the process LISTENING on port 3456 (LISTENING only - do not kill innocent
    #    processes that merely have an outbound connection to some :3456)
    $portConn = netstat -ano 2>$null | Select-String ":3456\s.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -ne '0' } | Sort-Object -Unique
    foreach ($procId in $portConn) {
        try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue; W-Info "Killed PID $procId" } catch {}
    }
    # 3) Match engine node/tsx processes by command line (node.exe Path is always the nodejs dir)
    $engineProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $cl = $_.CommandLine
        ($_.Name -in @('node.exe','tsx.exe')) -and $cl -and ($cl -like '*lingxi-engine*' -or $cl -like '*tsx*index.ts*')
    }
    foreach ($p in $engineProcs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; W-Info "Killed PID $($p.ProcessId)" } catch {}
    }
    # 4) Kill stray esbuild (locks its binary -> npm EBUSY)
    Get-Process -Name "esbuild" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    # 5) Fallback: node/tsx processes living under the install dir
    Get-Process -Name "node","tsx" -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -like "*lingxi-engine*" -or $_.MainWindowTitle -like "*lingxi*" } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
} catch {}
W-Info "Extracting to $InstallDir ..."
if (Test-Path $InstallDir) {
    W-Warn "Old install exists. New files will overwrite (your .env and data/ are preserved)."
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$extractTmp = Join-Path $env:TEMP "lingxi-extract-$(Get-Random)"
New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null
$extractOK = $false
try {
    # Full path to tar.exe (avoid PATH issues under irm|iex)
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
    # Fallback: .NET GZipStream decompress, then tar -xf
    W-Info "Trying .NET fallback extraction..."
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $gzStream = [System.IO.Compression.GZipStream]::new([System.IO.File]::OpenRead($tb), [System.IO.Compression.CompressionMode]::Decompress)
        $tarPath = "$extractTmp\archive.tar"
        $outStream = [System.IO.File]::Create($tarPath)
        $gzStream.CopyTo($outStream)
        $outStream.Close(); $gzStream.Close()
        $tarExe2 = "$env:SystemRoot\System32\tar.exe"
        if (Test-Path $tarExe2) {
            Start-Process -FilePath $tarExe2 -ArgumentList "-xf","`"$tarPath`"","-C","`"$extractTmp`"" -Wait -NoNewWindow
        }
        Remove-Item $tarPath -Force -EA SilentlyContinue
        $extractOK = $true
    } catch {
        W-Fail "Extract failed: $($_.Exception.Message). Need Windows 10 1809+ with tar.exe."
    }
}
$innerDir = Join-Path $extractTmp "lingxi-engine"
$copySrc = if (Test-Path $innerDir) { $innerDir } else { $extractTmp }
# robocopy is reliable for large trees (Copy-Item is not). Exit codes 0-7 = success.
$robocopyArgs = @($copySrc, $InstallDir, '/E', '/IS', '/IT', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS')
$rcResult = Start-Process -FilePath "robocopy" -ArgumentList $robocopyArgs -Wait -NoNewWindow -PassThru
if ($rcResult.ExitCode -ge 8) {
    W-Warn "robocopy exit code: $($rcResult.ExitCode), falling back to Copy-Item..."
    Get-ChildItem $copySrc -Force -Exclude "_err.txt" | ForEach-Object { Copy-Item $_.FullName $InstallDir -Recurse -Force }
}
if (-not (Test-Path (Join-Path $InstallDir "index.ts"))) {
    W-Fail "index.ts not found in $InstallDir after extraction. Installation corrupted."
}
if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
    W-Fail "package.json not found in $InstallDir after extraction. Installation corrupted."
}
W-OK "Extracted and verified"
Remove-Item $extractTmp -Recurse -Force -EA SilentlyContinue
Remove-Item $tb -Force -EA SilentlyContinue

New-Item -ItemType Directory -Path (Join-Path $InstallDir "data") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir "uploads") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir "workspace") -Force | Out-Null
# Force sandbox OFF (old installs may have enabled:true lingering)
[System.IO.File]::WriteAllText((Join-Path $InstallDir "data\sandbox-config.json"), '{"enabled":false}', [System.Text.Encoding]::UTF8)
W-OK "Directories created (sandbox: OFF)"

# --- 4. npm install ---
# better-sqlite3 is a NATIVE module. Its prebuilt binaries download from GitHub Releases,
# which is unreachable/slow on many networks (esp. China). prebuild-install honors this
# mirror env var (verified against prebuild-install/util.js getHostMirrorUrl):
#   npm_config_better_sqlite3_binary_host_mirror
$env:npm_config_better_sqlite3_binary_host_mirror = "https://npmmirror.com/mirrors/better-sqlite3/"
W-Info "Installing dependencies (this can take a few minutes)..."
Push-Location $InstallDir
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$npmOK = $false
$usedReg = "https://registry.npmmirror.com"
$registries = @(
    @{ Url = "https://registry.npmmirror.com"; Label = "npmmirror (fast in China)" },
    @{ Url = "https://registry.npmjs.org";    Label = "official npm registry" }
)
foreach ($r in $registries) {
    W-Info "npm install via $($r.Label) ..."
    $npmOut = & npm install --omit=optional --include=dev --no-audit --no-fund --registry=$($r.Url) 2>&1
    if ($LASTEXITCODE -eq 0) { $npmOK = $true; $usedReg = $r.Url; break }
    W-Warn "npm install failed via $($r.Label) (exit $LASTEXITCODE). Last lines:"
    $npmOut | Select-Object -Last 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}
$ErrorActionPreference = $prevEAP
if (-not $npmOK) {
    Pop-Location
    W-Fail "npm install failed on BOTH registries. Check network/proxy and re-run. If native compilation is the error, install 'Visual Studio Build Tools' (C++ workload) + Python, or ask for help with the error lines above."
}
# esbuild needs its platform binary; --omit=optional skipped it. Top it up explicitly.
$ErrorActionPreference = "Continue"
if (-not (Test-Path (Join-Path $InstallDir "node_modules\@esbuild\win32-x64"))) {
    & npm install "@esbuild/win32-x64" --no-save --no-audit --no-fund --registry=$usedReg 2>&1 | Out-Null
}
$ErrorActionPreference = $prevEAP
# HONEST verification gates (the old script printed [OK] even when npm failed twice):
if (-not (Test-Path (Join-Path $InstallDir "node_modules\tsx\dist\cli.mjs"))) {
    Pop-Location
    W-Fail "tsx is missing after npm install. Re-run the installer; if it persists, delete $InstallDir\node_modules and re-run."
}
$bs3check = & node -e "try{require('better-sqlite3');console.log('OK')}catch(e){console.log('ERR:'+e.message)}" 2>&1
if ("$bs3check" -notmatch 'OK') {
    Pop-Location
    W-Fail "better-sqlite3 native module failed to load: $bs3check. Install 'Visual Studio Build Tools' (C++ workload) and re-run, or re-run with a working network so the prebuilt binary can download."
}
$esbcheck = & node -e "try{var e=require('esbuild');e.transformSync('let x=1');console.log('OK')}catch(e){console.log('ERR:'+e.message)}" 2>&1
if ("$esbcheck" -notmatch 'OK') {
    Pop-Location
    W-Fail "esbuild toolchain check failed: $esbcheck. Delete $InstallDir\node_modules and re-run the installer."
}
W-OK "Dependencies installed and verified (tsx + better-sqlite3 + esbuild)"
Pop-Location

# --- 5. .env ---
$envFile = Join-Path $InstallDir ".env"
$ollamaOK = $false
if (-not (Test-Path $envFile)) {
    # Auto-generate secrets so a fresh install is never left with empty JWT/admin tokens
    $jwtSecret = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $adminToken = [guid]::NewGuid().ToString('N')
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

# --- Security (auto-generated at install time; keep secret) ---
JWT_SECRET=$jwtSecret
ADMIN_TOKEN=$adminToken

# --- Mesh Platform (cross-network social) ---
MESH_PLATFORM_URL=
MESH_TOKEN=change-me-to-a-strong-secret

# --- Server port ---
PORT=3456
"@
    [System.IO.File]::WriteAllText($envFile, $envContent, [System.Text.Encoding]::UTF8)
    W-OK ".env created (JWT_SECRET / ADMIN_TOKEN auto-generated)"
} else {
    W-OK ".env already exists (kept untouched)"
}

# --- 6. Check Ollama ---
W-Info "Checking Ollama..."
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

# --- 7. Permanent starter (double-click to run the engine any time) ---
# A .cmd launcher is quoting-proof (the old inline `powershell -Command` string was fragile)
# and its window STAYS OPEN on crash so the user can actually read the error.
$starterBody = @"
@echo off
title LingXi Engine
cd /d "C:\Users\Administrator\lingxi-engine"
echo ============================================
echo   LingXi Engine - starting...
echo   First start may take 30-60 seconds.
echo   Then open http://localhost:3456
echo ============================================
call npx tsx index.ts
echo.
echo Engine stopped. If an error is shown above, fix it and double-click this file again.
pause
"@
$starterPath = Join-Path $InstallDir "start-lingxi.cmd"
[System.IO.File]::WriteAllText($starterPath, $starterBody, [System.Text.Encoding]::ASCII)
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $desktopStarter = Join-Path $desktop "Start LingXi Engine.cmd"
    if (-not (Test-Path $desktopStarter)) {
        [System.IO.File]::WriteAllText($desktopStarter, $starterBody, [System.Text.Encoding]::ASCII)
        W-OK "Desktop shortcut created: Start LingXi Engine.cmd"
    }
} catch {}
W-OK "Starter created: $starterPath"

# --- 8. Done ---
Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host "  LingXi Engine installed!" -ForegroundColor White
Write-Host "  Version: $INSTALL_VERSION" -ForegroundColor Gray
Write-Host "===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Install dir : $InstallDir" -ForegroundColor Gray
Write-Host "  Start later : double-click 'Start LingXi Engine' on Desktop" -ForegroundColor Gray
Write-Host "                (or $starterPath)" -ForegroundColor Gray
Write-Host "  Open        : http://localhost:3456" -ForegroundColor White
Write-Host ""
if ($ollamaOK) {
    Write-Host "  Ollama models loaded automatically - you are ready!" -ForegroundColor Green
} else {
    Write-Host "  [Action Required] You need an AI model to chat:" -ForegroundColor Yellow
    Write-Host "    Local (free) : install https://ollama.com then: ollama run qwen2.5:7b" -ForegroundColor Gray
    Write-Host "    Cloud        : get a key (e.g. https://build.nvidia.com free tier)," -ForegroundColor Gray
    Write-Host "                   edit $envFile" -ForegroundColor Gray
    Write-Host "    Or in-app    : Settings -> Add Provider" -ForegroundColor Gray
}
Write-Host ""

# --- 9. Auto-start ---
# Reliable, NON-BLOCKING invocation-mode detection.
#   $PSCommandPath is EMPTY under `irm|iex`, SET under `powershell -File install.ps1`.
# WARNING: never use [Console]::In.Peek() or Read-Host to detect this. Under iex the
#   console Read-Host blocks forever WITHOUT rendering its prompt -> bare blinking cursor.
if (-not $script:IexMode) {
    $startNow = Read-Host "  Start now? (y/n)"
} else {
    Write-Host "  [One-liner mode] Auto-starting engine (no prompt)..." -ForegroundColor Cyan
    $startNow = 'y'
}
if ($startNow -eq 'y' -or $startNow -eq 'Y') {
    # Make sure port 3456 is free (LISTENING only)
    try {
        $portConn = netstat -ano 2>$null | Select-String ":3456\s.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Where-Object { $_ -ne '0' } | Sort-Object -Unique
        foreach ($p in $portConn) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }
        Start-Sleep -Seconds 1
    } catch {}
    W-Info "Starting engine..."
    # Poll health up to 90s (first tsx compile can be slow), then open the browser.
    Start-Job {
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 3
            try { Invoke-WebRequest http://127.0.0.1:3456/api/health -UseBasicParsing -TimeoutSec 5 | Out-Null; break } catch {}
        }
        Start-Process "http://127.0.0.1:3456"
    } | Out-Null
    if ($script:IexMode) {
        # Background: launch the .cmd starter minimized. Its window stays open on crash.
        Start-Process -FilePath $starterPath -WindowStyle Minimized
        W-Info "Engine starting in a minimized window (close it to stop the engine)."
        Write-Host "  Browser will open automatically when the engine is ready (up to 90s)." -ForegroundColor Cyan
        Write-Host "  If it does not come up, restore the minimized 'LingXi Engine' window to read the error." -ForegroundColor Gray
    } else {
        # -File mode: foreground so the user sees logs and can Ctrl+C
        Push-Location $InstallDir
        npx tsx index.ts
        Pop-Location
    }
}
Write-Host ""
Write-Host "  Open: http://localhost:3456" -ForegroundColor White
Write-Host ""
