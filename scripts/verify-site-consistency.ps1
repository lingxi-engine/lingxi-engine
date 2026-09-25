# verify-site-consistency.ps1 - end-to-end consistency gate for the published site
#
# WHY THIS SCRIPT EXISTS (v2.0.28):
#   A release is four separate objects served by the site:
#     /install.sh, /install.ps1, /public/version.txt, /public/lingxi-engine.tar.gz
#   Nothing checked that they agree with EACH OTHER. Real incident: the tarball's
#   embedded site/install.sh had SHA c2476059 while the served /install.sh had
#   a7980a85 - because a single file had been updated by hand. Users got an
#   installer that did not match the package it downloads.
#
# CHECKS (all must pass):
#   1. /public/version.txt first line == expected version (if -ExpectedVersion given)
#   2. tarball SHA256 == the SHA declared inside /public/version.txt
#   3. version.txt INSIDE the tarball == site version.txt
#   4. site/install.sh INSIDE the tarball == served /install.sh (SHA256)
#   5. BUILD-INFO.json INSIDE the tarball version == site version
#   6. package.json INSIDE the tarball version == site version
#   7. /download.html advertises the site version, links to the versioned archive, and has no
#      stale engine version strings (found live: page said 2.0.23 while the site served 2.0.28)
#   8. /public/lingxi-engine-<ver>.tar.gz exists and is byte-identical to the release artifact
#      (found live: v2.0.26/27/28 copies were missing, so the page's own link 404'd)
#   9. /install.ps1 is served and still points at the generic tarball
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-site-consistency.ps1
#   powershell ... -File scripts/verify-site-consistency.ps1 -ExpectedVersion 2.0.28
param(
    [string]$SiteUrl = 'http://47.93.157.83:8080',
    [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
$script:Fail = 0
$script:Pass = 0

function OK($m)   { Write-Host "  [OK]   $m"   -ForegroundColor Green;  $script:Pass++ }
function BAD($m)  { Write-Host "  [FAIL] $m"   -ForegroundColor Red;    $script:Fail++ }
function HEAD($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

function Get-Sha256($path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower() }
function Get-TarFile($tar, $entry) {
    $out = Join-Path $env:TEMP ('vsc-' + [guid]::NewGuid().ToString('N') + '.tmp')
    & tar -xzf $tar -O $entry 2>$null | Set-Content -Path $out -Encoding Byte -ErrorAction SilentlyContinue
    if (-not (Test-Path $out)) { return $null }
    return $out
}

$tmp = Join-Path $env:TEMP ('vsc-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    HEAD "1. fetch /public/version.txt"
    $verTxt = Join-Path $tmp 'version.txt'
    (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/public/version.txt", $verTxt)
    $verLines  = Get-Content $verTxt
    $siteVer   = $verLines[0].Trim()
    $siteBuilt = if ($verLines.Count -gt 1) { $verLines[1] } else { '' }
    Write-Host "     site version = '$siteVer'"
    Write-Host "     $siteBuilt"
    $declared = $null
    if ($siteBuilt -match 'SHA256\s+([0-9A-Fa-f]{64})') { $declared = $matches[1].ToLower() }
    if ($declared) { OK "version.txt declares tarball SHA256 $($declared.Substring(0,16))..." }
    else { BAD "version.txt has no SHA256 field to verify against" }
    if ($ExpectedVersion) {
        if ($siteVer -eq $ExpectedVersion) { OK "site version == expected $ExpectedVersion" }
        else { BAD "site version '$siteVer' != expected '$ExpectedVersion'" }
    }

    HEAD "2. download tarball and verify its SHA256"
    $tar = Join-Path $tmp 'lingxi-engine.tar.gz'
    (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/public/lingxi-engine.tar.gz", $tar)
    $tarSha = Get-Sha256 $tar
    $tarKB = [math]::Round((Get-Item $tar).Length / 1KB)
    Write-Host "     downloaded $tarKB KB, SHA256 $tarSha"
    if ($declared -and $tarSha -eq $declared) { OK "tarball SHA256 matches version.txt declaration" }
    elseif ($declared) { BAD "tarball SHA256 mismatch: declared $declared / actual $tarSha" }

    HEAD "3. version.txt INSIDE the tarball vs site version.txt"
    $tarVerFile = Join-Path $tmp 'in-pack-version.txt'
    & cmd /c "tar -xzf `"$tar`" -O ./lingxi-engine/version.txt > `"$tarVerFile`"" 2>$null
    if (-not (Test-Path $tarVerFile)) { BAD "version.txt missing from tarball" }
    else {
        $inVer = (Get-Content $tarVerFile -First 1).Trim()
        Write-Host "     in-pack version = '$inVer'"
        if ($inVer -eq $siteVer) { OK "in-pack version.txt == site version.txt ($siteVer)" }
        else { BAD "in-pack version '$inVer' != site version '$siteVer'" }
    }

    HEAD "4. site/install.sh INSIDE the tarball vs served /install.sh"
    $tarShFile = Join-Path $tmp 'in-pack-install.sh'
    & cmd /c "tar -xzf `"$tar`" -O ./lingxi-engine/site/install.sh > `"$tarShFile`"" 2>$null
    $servedSh = Join-Path $tmp 'served-install.sh'
    (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/install.sh", $servedSh)
    if (-not (Test-Path $tarShFile)) { BAD "site/install.sh missing from tarball" }
    else {
        $shaIn = Get-Sha256 $tarShFile
        $shaServed = Get-Sha256 $servedSh
        $szIn = (Get-Item $tarShFile).Length
        $szServed = (Get-Item $servedSh).Length
        Write-Host "     in-pack  site/install.sh : $shaIn ($szIn bytes)"
        Write-Host "     served   /install.sh     : $shaServed ($szServed bytes)"
        if ($shaIn -eq $shaServed) { OK "served installer == installer embedded in the package" }
        else { BAD "INSTALLER DRIFT: package installer != served installer (partial upload?)" }
    }

    HEAD "5. BUILD-INFO.json INSIDE the tarball vs site version"
    $biFile = Join-Path $tmp 'in-pack-buildinfo.json'
    & cmd /c "tar -xzf `"$tar`" -O ./lingxi-engine/BUILD-INFO.json > `"$biFile`"" 2>$null
    if (-not (Test-Path $biFile)) { BAD "BUILD-INFO.json missing from tarball" }
    else {
        $bi = Get-Content $biFile -Raw | ConvertFrom-Json
        Write-Host "     BUILD-INFO: version=$($bi.version) commit=$($bi.commit)"
        if ($bi.version -eq $siteVer) { OK "BUILD-INFO version == site version" }
        else { BAD "BUILD-INFO version '$($bi.version)' != site version '$siteVer'" }
    }

    HEAD "6. package.json INSIDE the tarball vs site version"
    $pkgFile = Join-Path $tmp 'in-pack-package.json'
    & cmd /c "tar -xzf `"$tar`" -O ./lingxi-engine/package.json > `"$pkgFile`"" 2>$null
    if (-not (Test-Path $pkgFile)) { BAD "package.json missing from tarball" }
    else {
        $pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
        Write-Host "     package.json version = $($pkg.version)"
        if ($pkg.version -eq $siteVer) { OK "package.json version == site version" }
        else { BAD "package.json version '$($pkg.version)' != site version '$siteVer'" }
    }
    HEAD "7. /download.html advertises the site version"
    $page = Join-Path $tmp 'download.html'
    try {
        (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/download.html", $page)
        $html = Get-Content $page -Raw
        $pageVers = [regex]::Matches($html, 'v(\d+\.\d+\.\d+)') |
                    ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
        Write-Host "     versions mentioned on the page: $($pageVers -join ', ')"
        if ($pageVers -contains $siteVer) { OK "download page advertises $siteVer" }
        else { BAD "download page never mentions $siteVer (stale page - nobody uploads it?)" }
        $stale = $pageVers | Where-Object { $_ -ne $siteVer -and $_ -notmatch '^1\.' }
        if ($stale) { BAD "download page also advertises older engine versions: $($stale -join ', ')" }
        else { OK "no stale engine version strings on the download page" }
        if ($html -match '/public/version\.txt') { OK "download page reads /public/version.txt at runtime" }
        else { BAD "download page has no runtime version lookup - it will drift on every release" }
        if ($html -match "lingxi-engine-v$([regex]::Escape($siteVer))\.tar\.gz") { OK "download page links to the versioned archive" }
        else { BAD "download page does not link to lingxi-engine-v$siteVer.tar.gz" }
    } catch {
        BAD "cannot fetch /download.html: $($_.Exception.Message)"
    }

    HEAD "8. versioned archive copy is reachable and identical to the release artifact"
    try {
        $verTar = Join-Path $tmp 'lingxi-engine-versioned.tar.gz'
        (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/public/lingxi-engine-v$siteVer.tar.gz", $verTar)
        $verSha = Get-Sha256 $verTar
        Write-Host "     /public/lingxi-engine-v$siteVer.tar.gz SHA256 $verSha"
        if ($declared -and $verSha -eq $declared) { OK "versioned archive copy is byte-identical to the release artifact" }
        elseif ($declared) { BAD "versioned archive copy differs from the release artifact ($verSha vs $declared)" }
        else { OK "versioned archive copy exists (no declared SHA to compare)" }
    } catch {
        BAD "download page link would 404: /public/lingxi-engine-v$siteVer.tar.gz is not served"
    }

    HEAD "9. install.ps1 (Windows entry point) is served"
    try {
        $ps1 = Join-Path $tmp 'install.ps1'
        (New-Object System.Net.WebClient).DownloadFile("$SiteUrl/install.ps1", $ps1)
        $ps1sz = (Get-Item $ps1).Length
        Write-Host "     /install.ps1 $ps1sz bytes"
        $ps1txt = Get-Content $ps1 -Raw
        if ($ps1txt -match 'lingxi-engine\.tar\.gz') { OK "install.ps1 points at the generic tarball" }
        else { BAD "install.ps1 does not reference lingxi-engine.tar.gz" }
    } catch {
        BAD "cannot fetch /install.ps1: $($_.Exception.Message)"
    }
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Fail -eq 0) {
    Write-Host "SITE CONSISTENT: $script:Pass checks passed, 0 failed." -ForegroundColor Green
    exit 0
} else {
    Write-Host "SITE INCONSISTENT: $script:Pass passed, $script:Fail FAILED." -ForegroundColor Red
    exit 1
}
