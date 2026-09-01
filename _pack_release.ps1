# Lingxi Engine pack script v2 (2026-08-26 fixed)
# Usage: powershell -ExecutionPolicy Bypass -File .\_pack_release.ps1
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutFile = Join-Path $env:TEMP "lingxi-engine-v2.0.12.tar.gz"

# Exclude rules (NOTE: --exclude=storage would match src/storage/, use exact paths)
# NOTE: do NOT add --exclude=./mobile - bsdtar matches it against src/mobile/* too (prefix match)
$excludes = @(
    '--exclude=./node_modules',
    '--exclude=./.git',
    '--exclude=./.env',
    '--exclude=./workspace',
    '--exclude=./data',
    '--exclude=./docs',
    '--exclude=./mobile-dist',
    '--exclude=./app',
    '--exclude=./diffrhythm-local',
    '--exclude=./song_maker',
    '--exclude=./_verify_tmp',
    '--exclude=./_release_check',
    '--exclude=./_pkgx',
    '--exclude=./backup_20260825_reasoning',
    '--exclude=*.tar.gz',
    '--exclude=*.bak*',
    '--exclude=*_cleanup-bak-*',
    '--exclude=*.patch-ctor',
    '--exclude=fix-task-interrupt*.cjs',
    '--exclude=*.log',
    '--exclude=*.tmp',
    '--exclude=patch-db.cjs',
    '--exclude=startup.err',
    '--exclude=usage.json',
    '--exclude=./src/web',
    '--exclude=./src/web_backup_v9',
    '--exclude=./_archive',
    '--exclude=./_add_market_routes.cjs',
    '--exclude=./_pack_release.ps1',
    '--exclude=./_junk*'
)

# Pack
Push-Location $ProjectRoot
try {
    tar czf $OutFile @excludes -C "." .
    $sz = (Get-Item $OutFile).Length
    $mb = [math]::Round($sz / 1MB, 2)
    Write-Host "SIZE: $sz bytes ($mb MB)" -ForegroundColor Green
    Write-Host "PATH: $OutFile" -ForegroundColor Cyan

    # Verify key files
    Write-Host ""
    Write-Host "Verify key files..." -ForegroundColor Yellow
    $keyFiles = @('index.ts', 'src/storage/db.ts', 'src/core/router.ts', 'src/mobile/index.ts', 'web/index.html', 'web/js/app.js', 'package.json')
    foreach ($f in $keyFiles) {
        $found = tar -tzf $OutFile | Select-String -Pattern $f -SimpleMatch
        if ($found) {
            Write-Host "  [OK] $f" -ForegroundColor Green
        } else {
            Write-Host "  [MISSING] $f" -ForegroundColor Red
        }
    }
} finally {
    Pop-Location
}
