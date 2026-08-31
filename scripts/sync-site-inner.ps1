# sync-site-inner.ps1 - sync src/ -> workspace/site_inner/ deploy copy
# Usage:
#   powershell -File scripts/sync-site-inner.ps1              # sync (mirror, removes extra files)
#   powershell -File scripts/sync-site-inner.ps1 -CheckOnly   # check diff only, no changes
# Rule: src/ is the single source of truth; site_inner is a build artifact.
#       Never hand-edit site_inner (see docs/ARCHITECTURE.md section 3).

param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # project root
$src  = Join-Path $root 'src'
$dst  = Join-Path $root 'workspace\site_inner'

if (-not (Test-Path $dst)) {
    Write-Host "[sync] target dir not found: $dst" -ForegroundColor Red
    exit 1
}

# sync list: mirrored dirs + root-level key files
$dirs = @('src', 'web', 'app', 'mobile', 'skills', 'css', 'scripts', 'storage')
$files = @('index.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
           'version.txt', 'deploy.sh', 'install.sh', 'install.ps1',
           'install-server.ps1', 'setup.sh', 'setup.bat', 'start.bat',
           'start-dev.sh', 'ecosystem.config.cjs', '.env.example')

$fail = 0

# ---- mirror dirs (robocopy /MIR includes removing extra files) ----
foreach ($d in $dirs) {
    $s = Join-Path $root $d
    $t = Join-Path $dst $d
    if (-not (Test-Path $s)) { Write-Host "[skip] $d (source missing)" -ForegroundColor Yellow; continue }
    if ($CheckOnly) {
        $r = robocopy $s $t /E /L /NJH /NJS /NP /NFL /NDL
        $diffCount = ($r | Where-Object { $_ -match '\S' }).Count
        if ($diffCount -gt 0) { Write-Host "[diff] $d has $diffCount differences" -ForegroundColor Yellow; $fail++ }
        else { Write-Host "[ok]   $d in sync" -ForegroundColor Green }
    } else {
        robocopy $s $t /MIR /NJH /NJS /NP | Out-Null
        $code = $LASTEXITCODE
        if ($code -ge 8) { Write-Host "[FAIL] $d robocopy exit=$code" -ForegroundColor Red; $fail++ }
        else { Write-Host "[sync] $d done (robocopy exit=$code)" -ForegroundColor Green }
    }
}

# ---- root-level files: copy one by one ----
foreach ($f in $files) {
    $s = Join-Path $root $f
    $t = Join-Path $dst $f
    if (-not (Test-Path $s)) { Write-Host "[skip] $f (source missing)" -ForegroundColor Yellow; continue }
    $same = $false
    if (Test-Path $t) {
        $same = ((Get-FileHash $s).Hash -eq (Get-FileHash $t).Hash)
    }
    if ($CheckOnly) {
        if ($same) { Write-Host "[ok]   $f in sync" -ForegroundColor Green }
        else { Write-Host "[diff] $f differs" -ForegroundColor Yellow; $fail++ }
    } else {
        Copy-Item $s $t -Force
        Write-Host "[sync] $f" -ForegroundColor Green
    }
}

Write-Host ''
if ($CheckOnly) {
    if ($fail -gt 0) { Write-Host "CHECK DONE: $fail item(s) out of sync. Run sync mode before deploying." -ForegroundColor Yellow; exit 1 }
    else { Write-Host 'CHECK DONE: site_inner fully in sync with source.' -ForegroundColor Green; exit 0 }
} else {
    Write-Host 'SYNC DONE. Note: one-off patch scripts (_*) inside site_inner are legacy, not synced, pending archive.' -ForegroundColor Cyan
    exit 0
}