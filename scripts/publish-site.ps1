# publish-site.ps1 - package and publish LingXi Engine to the official site server
#
# WHY THIS SCRIPT EXISTS:
#   http://47.93.157.83:8080/install.ps1 is the only distribution entry point.
#   It hardcodes the download URL http://47.93.157.83:8080/public/lingxi-engine.tar.gz
#   Before this script, pack-release.ps1 only produced a LOCAL tarball and the
#   public/ copy was uploaded by hand, which caused version drift
#   (local 2.0.25 vs server 2.0.23): users running irm install.ps1 | iex always
#   installed a stale build.
#
# USAGE:
#   powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -CheckOnly
#       # compare local vs live version only, uploads nothing (safe, run this first)
#   powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1
#      # package + upload (requires deploy config, see below)
#
# Deploy method (pick one, default scp):
#   -Method scp     : needs SSH access (recommended, key-based auth)
#   -Method ftp     : needs FTP account
#   -Method manual  : package only, prints a manual upload checklist (no creds needed)
#
# Credentials are read from environment variables only - never hardcoded:
#   LINGXI_DEPLOY_HOST   server host (default 47.93.157.83)
#   LINGXI_DEPLOY_USER   SSH/FTP username
#   LINGXI_DEPLOY_PORT   SSH port (default 22)
#   LINGXI_DEPLOY_PATH   absolute path of public/ on the server
#   LINGXI_DEPLOY_KEY    SSH private key path (optional)
#
# SECURITY: this script never reads, prints or writes any .env content.
# Uploaded artifacts: lingxi-engine.tar.gz, version.txt, install.sh, install.ps1.
#
# NOTE: this file is intentionally ASCII-only. PowerShell on a zh-CN box parses
# a BOM-less UTF-8 .ps1 as GBK, which corrupts non-ASCII text and breaks parsing.

[CmdletBinding()]
param(
    [ValidateSet('scp','ftp','manual')]
    [string]$Method = 'scp',
    [switch]$CheckOnly,
    [string]$OutDir = (Join-Path $env:TEMP 'lingxi-publish')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'index.ts'))) {
    $RepoRoot = (Get-Location).Path
}

$SiteUrl      = 'http://47.93.157.83:8080'
$InstallUrl   = "$SiteUrl/install.ps1"
$RemoteVerUrl = "$SiteUrl/public/version.txt"

function W-OK($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function W-Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function W-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function W-Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

# ---------- 0. local version ----------
$LocalVersion = (Get-Content (Join-Path $RepoRoot 'version.txt') -Raw).Trim()
$LocalCommit  = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
if (-not $LocalCommit) { $LocalCommit = 'unknown' }
W-Info "local version: $LocalVersion (commit $LocalCommit)"

# ---------- 1. live version probe ----------
$RemoteVersion = $null
try {
    $r = Invoke-WebRequest -Uri $RemoteVerUrl -UseBasicParsing -TimeoutSec 15
    $RemoteVersion = (([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) -split "`n")[0]).Trim()
    W-Info "live version: $RemoteVersion"
} catch {
    W-Warn "cannot read live version.txt ($RemoteVerUrl): $($_.Exception.Message)"
}

# ---------- 2. version comparison ----------
$inSync = $false
if ($RemoteVersion) {
    if ($RemoteVersion -eq $LocalVersion) {
        $inSync = $true
        W-OK "local and live versions match ($LocalVersion)"
    } else {
        W-Warn "VERSION DRIFT: local $LocalVersion vs live $RemoteVersion"
        W-Warn "-> users running irm $InstallUrl | iex will install the stale $RemoteVersion"
    }
}

# ---------- 3. install.ps1 download source check ----------
try {
    $ips = Invoke-WebRequest -Uri $InstallUrl -UseBasicParsing -TimeoutSec 15
    $tarLine = ([System.Text.Encoding]::UTF8.GetString($ips.RawContentStream.ToArray()) -split "`n") | Where-Object { $_ -match 'lingxi-engine\.tar\.gz' } | Select-Object -First 1
    if ($tarLine) {
        W-Info "install.ps1 download source: $($tarLine.Trim())"
        if ($tarLine -notmatch [regex]::Escape($SiteUrl)) {
            W-Warn "install.ps1 tarball URL does not match the expected site - verify manually"
        }
    }
} catch {
    W-Warn "cannot read install.ps1: $($_.Exception.Message)"
}

if ($CheckOnly) {
    Write-Host ""
    if ($inSync) { W-OK "check done: nothing to publish" }
    else { W-Warn "check done: publish required (drop -CheckOnly and configure deploy method)" }
    exit 0
}

# ---------- 4. package ----------
W-Info "packaging (calling scripts/pack-release.ps1) ..."
$packScript = Join-Path $RepoRoot 'scripts\pack-release.ps1'
if (-not (Test-Path $packScript)) { W-Fail "pack script not found: $packScript" }
& powershell -NoProfile -ExecutionPolicy Bypass -File $packScript
if ($LASTEXITCODE -ne 0) { W-Fail "packaging failed - aborting publish (nothing uploaded)" }

$tarball = Join-Path $env:TEMP "lingxi-engine-v$LocalVersion.tar.gz"
if (-not (Test-Path $tarball)) {
    $cand = Get-ChildItem (Join-Path $env:TEMP 'lingxi-engine-v*.tar.gz') |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $cand) { W-Fail "no tar.gz artifact found after packaging" }
    $tarball = $cand.FullName
}
$sizeKB = [math]::Round((Get-Item $tarball).Length / 1KB)
W-OK "artifact: $tarball ($sizeKB KB)"

# ---------- 5. generate version.txt (same format as live) ----------
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$sha = (Get-FileHash -Algorithm SHA256 $tarball).Hash
$stamp = Get-Date -Format 'yyyy-MM-dd'
$verBody = "$LocalVersion`nbuilt: $stamp (v$LocalVersion publish; local HEAD $LocalCommit; SHA256 $sha)"
$verFile = Join-Path $OutDir 'version.txt'
[System.IO.File]::WriteAllText($verFile, $verBody, [System.Text.Encoding]::UTF8)
W-OK "version.txt generated (SHA256 $($sha.Substring(0,16))...)"

# ---------- 5.5 install scripts (version drift root cause fix) ----------
# install.sh used to hardcode VERSION="2.0.23" and lived only on the server,
# so it never followed the repo. Now it is tracked in site/ and uploaded with
# every publish, and its version is read from the deployed version.txt.
$siteDir = Join-Path $RepoRoot 'site'
$installSh = Join-Path $siteDir 'install.sh'
$installPs1 = Join-Path $siteDir 'install.ps1'
foreach ($f in @($installSh, $installPs1)) {
    if (-not (Test-Path $f)) { W-Fail "install script missing: $f (expected in site/)" }
}
W-OK "install scripts staged: install.sh, install.ps1"

# ---------- 6. upload ----------
$Host_ = $env:LINGXI_DEPLOY_HOST
$User_ = $env:LINGXI_DEPLOY_USER
$Port_ = $env:LINGXI_DEPLOY_PORT
$Path_ = $env:LINGXI_DEPLOY_PATH
$Key_  = $env:LINGXI_DEPLOY_KEY

if ($Method -eq 'manual') {
    W-Warn "manual mode: no upload performed. Copy these two files to the server public/ dir:"
    Write-Host "  1) $tarball  ->  $SiteUrl/public/lingxi-engine.tar.gz" -ForegroundColor Yellow
    Write-Host "  2) $verFile  ->  $SiteUrl/public/version.txt" -ForegroundColor Yellow
    Write-Host "  3) $installSh  ->  $SiteUrl/install.sh" -ForegroundColor Yellow
    Write-Host "  4) $installPs1 ->  $SiteUrl/install.ps1" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  after upload verify: curl $RemoteVerUrl should return $LocalVersion" -ForegroundColor Yellow
    exit 0
}

if (-not $Host_ -or -not $User_ -or -not $Path_) {
    W-Fail "missing deploy credentials. Set LINGXI_DEPLOY_HOST / LINGXI_DEPLOY_USER / LINGXI_DEPLOY_PATH, or use -Method manual"
}
if (-not $Port_) { $Port_ = '22' }

if ($Method -eq 'scp') {
    if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
        W-Fail "scp not found. Install OpenSSH Client, or use -Method manual"
    }
    $sshArgs = @()
    if ($Key_) { $sshArgs += '-i', $Key_ }
    $sshArgs += '-P', $Port_

    W-Info "upload tarball -> ${User_}@${Host_}:${Path_}/lingxi-engine.tar.gz"
    & scp @sshArgs $tarball "${User_}@${Host_}:${Path_}/lingxi-engine.tar.gz"
    if ($LASTEXITCODE -ne 0) { W-Fail "tarball upload failed (version.txt untouched, live still old - safe)" }

    W-Info "upload version.txt"
    & scp @sshArgs $verFile "${User_}@${Host_}:${Path_}/version.txt"
    if ($LASTEXITCODE -ne 0) { W-Fail "version.txt upload failed (tarball uploaded but version file stale - retry)" }

    W-Info "upload install.sh"
    & scp @sshArgs $installSh "${User_}@${Host_}:${Path_}/../install.sh"
    if ($LASTEXITCODE -ne 0) { W-Fail "install.sh upload failed (tarball+version already live; retry)" }

    W-Info "upload install.ps1"
    & scp @sshArgs $installPs1 "${User_}@${Host_}:${Path_}/../install.ps1"
    if ($LASTEXITCODE -ne 0) { W-Fail "install.ps1 upload failed (retry)" }
}
elseif ($Method -eq 'ftp') {
    if (-not (Get-Command ftp -ErrorAction SilentlyContinue)) { W-Fail "ftp not found" }
    W-Warn "ftp mode is plaintext - only for LAN / temporary use"
    $ftpScript = Join-Path $OutDir 'ftp-commands.txt'
    $cmds = @(
        "open $Host_"
        "binary"
        "put `"$tarball`" lingxi-engine.tar.gz"
        "put `"$verFile`" version.txt"
        "put `"$installSh`" install.sh"
        "put `"$installPs1`" install.ps1"
        "bye"
    )
    [System.IO.File]::WriteAllText($ftpScript, ($cmds -join "`r`n"), [System.Text.Encoding]::ASCII)
    & ftp -s:$ftpScript
    if ($LASTEXITCODE -ne 0) { W-Fail "ftp upload failed" }
}

# ---------- 7. post-publish self check ----------
W-Info "waiting 3s then verifying live version ..."
Start-Sleep -Seconds 3
try {
    $chk = [System.Text.Encoding]::UTF8.GetString((Invoke-WebRequest -Uri $RemoteVerUrl -UseBasicParsing -TimeoutSec 15).RawContentStream.ToArray())
    $chkVer = ($chk -split "`n")[0].Trim()
    if ($chkVer -eq $LocalVersion) {
        W-OK "PUBLISH OK: live version = $chkVer"
        W-OK "now irm $InstallUrl | iex installs the latest build"
    } else {
        W-Warn "live returned $chkVer, expected $LocalVersion (CDN cache? retry shortly or check server path)"
    }
} catch {
    W-Warn "self-check failed: $($_.Exception.Message). Manually run: curl $RemoteVerUrl"
}

Write-Host ""
W-OK "publish flow finished"
