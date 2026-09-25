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
$LocalVersion = (Get-Content (Join-Path $RepoRoot 'version.txt') -Raw).Trim().TrimStart([char]0xFEFF)
$LocalCommit  = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
if (-not $LocalCommit) { $LocalCommit = 'unknown' }
W-Info "local version: $LocalVersion (commit $LocalCommit)"

# ---------- 1. live version probe ----------
$RemoteVersion = $null
try {
    $r = Invoke-WebRequest -Uri $RemoteVerUrl -UseBasicParsing -TimeoutSec 15
    $RemoteVersion = (([System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) -split "`n")[0]).Trim().TrimStart([char]0xFEFF)
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
# v2.0.26 FIX: [System.Text.Encoding]::UTF8 emits a BOM (EF BB BF), which made the
# remote version.txt read back as "<BOM>2.0.25". String.Trim() does NOT strip U+FEFF,
# so the drift check below could never report "in sync". Write BOM-less, matching the
# pack-release.ps1 v6.9 fix for the same bug class.
[System.IO.File]::WriteAllText($verFile, $verBody, (New-Object System.Text.UTF8Encoding $false))
$verBytes = [System.IO.File]::ReadAllBytes($verFile)
if ($verBytes.Length -ge 3 -and $verBytes[0] -eq 0xEF -and $verBytes[1] -eq 0xBB -and $verBytes[2] -eq 0xBF) {
    W-Fail "version.txt still carries a UTF-8 BOM - aborting publish (BOM breaks the drift check)"
}
W-OK "version.txt is BOM-less ($($verBytes.Length) bytes)"
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

# ---------- 5.6 download page (v2.0.28) ----------
# WHY: /download.html was never part of the upload set, so it drifted silently - the public
# download page advertised v2.0.23 while the site already served 2.0.28. The page now reads
# /public/version.txt at runtime, but its static fallback values must still follow every
# release, and the page links to /public/lingxi-engine-<ver>.tar.gz.
# Same class of bug as the orphan version.txt: a file nobody uploads is a file that will lie.
$downloadHtml = Join-Path $RepoRoot 'web\download.html'
if (Test-Path $downloadHtml) {
    W-OK "download page staged: web/download.html"
} else {
    $downloadHtml = $null
    W-Warn "web/download.html not found - the public download page will not be published"
}

# ---------- 6. upload ----------
$Host_ = $env:LINGXI_DEPLOY_HOST
$User_ = $env:LINGXI_DEPLOY_USER
$Port_ = $env:LINGXI_DEPLOY_PORT
$Path_ = $env:LINGXI_DEPLOY_PATH
$Key_  = $env:LINGXI_DEPLOY_KEY

if ($Method -eq 'manual') {
    # v2.0.26 FIX: said "two files" but lists four. Also listed items 3/4 as $SiteUrl/install.sh,
    # which is the URL users hit, not where the file must live - server.js serves both from public/ ONLY.
    W-Warn "manual mode: no upload performed. Copy these files into the server public/ dir:"
    Write-Host "  1) $tarball  ->  $SiteUrl/public/lingxi-engine.tar.gz" -ForegroundColor Yellow
    Write-Host "  2) $tarball  ->  $SiteUrl/public/lingxi-engine-v$LocalVersion.tar.gz (versioned copy; download page links here)" -ForegroundColor Yellow
    Write-Host "  3) $verFile  ->  $SiteUrl/public/version.txt" -ForegroundColor Yellow
    Write-Host "  4) $installSh  ->  $SiteUrl/public/install.sh" -ForegroundColor Yellow
    Write-Host "  5) $installPs1 ->  $SiteUrl/public/install.ps1" -ForegroundColor Yellow
    if ($downloadHtml) { Write-Host "  6) $downloadHtml ->  $SiteUrl/public/download.html" -ForegroundColor Yellow }
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
    # v2.0.26 FIX: was "${Path_}/../install.sh" (i.e. /var/www/lingxi/install.sh), but
    # server.js serves GET /install.sh from public/ ONLY - the parent dir is a dead path,
    # so scp mode never actually updated the installer users download. Aligned with the
    # FTP branch and -manual instructions, which both target public/.
    & scp @sshArgs $installSh "${User_}@${Host_}:${Path_}/install.sh"
    if ($LASTEXITCODE -ne 0) { W-Fail "install.sh upload failed (tarball+version already live; retry)" }

    W-Info "upload install.ps1"
    # v2.0.26 FIX: same dead-path bug as install.sh above - server.js reads install.ps1 from public/ too.
    & scp @sshArgs $installPs1 "${User_}@${Host_}:${Path_}/install.ps1"
    if ($LASTEXITCODE -ne 0) { W-Fail "install.ps1 upload failed (retry)" }

    # v2.0.28 FIX: publish the download page in the same transaction as the artifacts it
    # describes. Warn (not fail) so a page-only problem cannot block a code release.
    if ($downloadHtml) {
        W-Info "upload web/download.html"
        & scp @sshArgs $downloadHtml "${User_}@${Host_}:${Path_}/download.html"
        if ($LASTEXITCODE -ne 0) { W-Warn "download.html upload failed - the public page may show a stale version" }
    }

    # v2.0.28 FIX: keep a versioned copy of the artifact, because download.html links to
    # /public/lingxi-engine-<ver>.tar.gz while only the generic name was being uploaded, so the
    # current release's link 404'd (found: the v2.0.26/27/28 copies were all missing server-side).
    W-Info "upload versioned archive copy -> lingxi-engine-v$LocalVersion.tar.gz"
    & scp @sshArgs $tarball "${User_}@${Host_}:${Path_}/lingxi-engine-v$LocalVersion.tar.gz"
    if ($LASTEXITCODE -ne 0) { W-Warn "versioned archive copy upload failed - download page link may 404" }

    # v2.0.27 FIX: refresh the ORPHAN parent-dir copy of version.txt in the same transaction.
    # Nothing serves it (server.js reads public/ only), but it keeps drifting and misleading
    # operators: found stale at 2.0.23, then at "2.0.25 / d787b34" (a commit that does not even
    # exist in main), then stale AGAIN at 2.0.26. Hand-patching it every release does not scale;
    # fixing the root cause does. Harmless if it fails, so warn instead of fail.
    $ParentDir = ($Path_.TrimEnd("/") -replace "/public$", "")
    if ($ParentDir -and $ParentDir -ne $Path_.TrimEnd("/")) {
        $ParentVer = "$ParentDir/version.txt"
        if (Get-Command ssh -ErrorAction SilentlyContinue) {
            $sshCmdArgs = @()
            if ($Key_) { $sshCmdArgs += "-i", $Key_ }
            $sshCmdArgs += "-p", $Port_, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"
            W-Info "sync orphan copy -> $ParentVer"
            $cpCmd = "cp -f " + $Path_ + "/version.txt " + $ParentVer + " && cat " + $ParentVer
            & ssh @sshCmdArgs "${User_}@${Host_}" $cpCmd
            if ($LASTEXITCODE -ne 0) { W-Warn "orphan version.txt sync failed (harmless: not served over HTTP)" }
        } else {
            W-Warn "ssh not found - orphan $ParentVer left stale (harmless: not served)"
        }
    }
}
elseif ($Method -eq 'ftp') {
    if (-not (Get-Command ftp -ErrorAction SilentlyContinue)) { W-Fail "ftp not found" }
    W-Warn "ftp mode is plaintext - only for LAN / temporary use"
    $ftpScript = Join-Path $OutDir 'ftp-commands.txt'
    $cmds = @(
        "open $Host_"
        "binary"
        "put `"$tarball`" lingxi-engine.tar.gz"
        "put `"$tarball`" lingxi-engine-v$LocalVersion.tar.gz"
        "put `"$verFile`" version.txt"
        "put `"$installSh`" install.sh"
        "put `"$installPs1`" install.ps1"
    )
    if ($downloadHtml) { $cmds += "put `"$downloadHtml`" download.html" }
    $cmds += "bye"
    [System.IO.File]::WriteAllText($ftpScript, ($cmds -join "`r`n"), [System.Text.Encoding]::ASCII)
    & ftp -s:$ftpScript
    if ($LASTEXITCODE -ne 0) { W-Fail "ftp upload failed" }
}

# ---------- 7. post-publish self check ----------
W-Info "waiting 3s then verifying live version ..."
Start-Sleep -Seconds 3
try {
    $chk = [System.Text.Encoding]::UTF8.GetString((Invoke-WebRequest -Uri $RemoteVerUrl -UseBasicParsing -TimeoutSec 15).RawContentStream.ToArray())
    $chkVer = ($chk -split "`n")[0].Trim().TrimStart([char]0xFEFF)
    if ($chkVer -eq $LocalVersion) {
        W-OK "PUBLISH OK: live version = $chkVer"
        W-OK "now irm $InstallUrl | iex installs the latest build"
    } else {
        W-Warn "live returned $chkVer, expected $LocalVersion (CDN cache? retry shortly or check server path)"
    }
} catch {
    W-Warn "self-check failed: $($_.Exception.Message). Manually run: curl $RemoteVerUrl"
}

# v2.0.27 GATE: byte-level verification. Version strings alone cannot prove users receive the
# right bits - v2.0.26 shipped a dead-path bug where scp uploaded install.sh into the parent
# dir, so every version check stayed green while users kept downloading a stale installer.
# So: fetch what users actually get, and compare SHA256 against the local files.
if (Get-Command ssh -ErrorAction SilentlyContinue) {
    try {
        $wc = New-Object System.Net.WebClient
        # NOTE: ::Create without () yields a PSMethod, not an instance -> "does not contain a
        # method named ComputeHash". Needs the call parentheses.
        $sha = [System.Security.Cryptography.SHA256]::Create()

        # NOTE: $InstallUrl is the POWERSHELL installer (/install.ps1). Comparing it against the
        # local install.sh produced a bogus "stale installer" warning the first time this gate ran.
        # Check both installers against their own counterpart, over the URLs users really hit.
        $pairs = @(
            @{ Name = "install.sh";  Url = "$SiteUrl/install.sh";  Path = $installSh },
            @{ Name = "install.ps1"; Url = $InstallUrl;            Path = $installPs1 }
        )
        foreach ($pair in $pairs) {
            $localHash = (Get-FileHash -Path $pair.Path -Algorithm SHA256).Hash.ToLower()
            $liveBytes = $wc.DownloadData($pair.Url)
            $liveHash = ([BitConverter]::ToString($sha.ComputeHash($liveBytes)) -replace "-", "").ToLower()
            if ($liveHash -eq $localHash) {
                W-OK "live $($pair.Name) is byte-identical to local ($($localHash.Substring(0,16))...)"
            } else {
                W-Warn "live $($pair.Name) DIFFERS from local (live $($liveHash.Substring(0,12))... vs local $($localHash.Substring(0,12))...) - users may get a stale installer"
            }
        }

        # Does the artifact match the SHA256 that version.txt claims? (the "metadata that lies" bug)
        $declared = $null
        if ($chk) {
            $m = [regex]::Match($chk, "SHA256[ 	]+([0-9A-Fa-f]{64})")
            if ($m.Success) { $declared = $m.Groups[1].Value.ToLower() }
        }
        if ($declared) {
            $tarUrl = "$SiteUrl/public/lingxi-engine.tar.gz"
            $liveTarBytes = $wc.DownloadData($tarUrl)
            $liveTarHash = ([BitConverter]::ToString($sha.ComputeHash($liveTarBytes)) -replace "-", "").ToLower()
            if ($liveTarHash -eq $declared) {
                W-OK "live tarball matches the SHA256 declared in version.txt ($($declared.Substring(0,16))...)"
            } else {
                W-Warn "live tarball SHA256 $($liveTarHash.Substring(0,12))... does NOT match declared $($declared.Substring(0,12))... - version.txt is lying"
            }
        } else {
            W-Warn "no SHA256 declared in live version.txt - cannot verify artifact identity"
        }

        # v2.0.28: the download page and the versioned archive copy were the two objects nobody
        # checked. Verify them here so a partial upload cannot pass this gate unnoticed again.
        if ($downloadHtml) {
            try {
                $livePage = [System.Text.Encoding]::UTF8.GetString($wc.DownloadData("$SiteUrl/download.html"))
                if ($livePage -match "v$([regex]::Escape($LocalVersion))") {
                    W-OK "live download.html advertises v$LocalVersion"
                } else {
                    W-Warn "live download.html does not mention v$LocalVersion - page may be stale"
                }
            } catch {
                W-Warn "download.html check skipped: $($_.Exception.Message)"
            }
        }
        try {
            $verUrl2 = "$SiteUrl/public/lingxi-engine-v$LocalVersion.tar.gz"
            $verBytes2 = $wc.DownloadData($verUrl2)
            $verHash2 = ([BitConverter]::ToString($sha.ComputeHash($verBytes2)) -replace "-", "").ToLower()
            if ($verHash2 -eq ($sha.ToString().ToLower())) {
                W-OK "versioned archive copy is byte-identical to the release artifact"
            } else {
                W-Warn "versioned archive copy differs from the release artifact (users would get the wrong build)"
            }
        } catch {
            W-Warn "versioned archive copy not reachable at $SiteUrl/public/lingxi-engine-v$LocalVersion.tar.gz"
        }
    } catch {
        W-Warn "byte-level gate skipped: $($_.Exception.Message)"
    }
}

Write-Host ""
W-OK "publish flow finished"
