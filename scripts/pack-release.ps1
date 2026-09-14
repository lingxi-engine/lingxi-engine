# Lingxi Engine pack script v6.8 (2026-09-14: assertions -> v2.0.20/sw-v20 + credit-backfill/no-require guards (v6.7 2026-09-12: �޸�Ƕ���������� + ���� .env ģ��)
#   v6.7 ���:
#     - ���� Remove-JunkFiles: �ݹ����� __pycache__/*.pyc/*.bak*/_result.txt/tests/data/*.json
#       (v6.6 �� $excludeFilesRegex ֻ�����ڶ��㣬���� src/��lingxi_engine/ �ڵ������������)
#     - Remove-EnvFiles ��Ϊ���� .env.example / .env.template��install.sh ���� .env.example��
#     - ����: �����ļ������У�� + .env.example ������У��
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\pack-release.ps1
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutFile = Join-Path $env:TEMP "lingxi-engine-v2.0.20.tar.gz"

# Stage into a temp dir with lingxi-engine/ prefix so install.ps1 finds the inner dir
$StageRoot = Join-Path $env:TEMP "lingxi-engine-staging-$(Get-Random)"
$StageDir = Join-Path $StageRoot "lingxi-engine"
if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

$excludeDirs = @('node_modules','.git','workspace','data','data-platform','docs','mobile-dist','app','diffrhythm-local','song_maker','_verify_tmp','_release_check','_pkgx','backup_20260825_reasoning','data-smoke-b13b','_smoke_v5_data','_archive','release','release-v2')
$excludeDirsRegex = '^backup[_-]'
$excludeFilesRegex = '\.tar\.gz$|\.bak|\.orig$|\.zip$|_cleanup-bak-|\.patch-ctor|fix-task-interrupt.*\.cjs|fix-install\.cjs$|patch-admin\.|\.log$|\.tmp$|patch-db\.cjs|startup\.err|usage\.json$|\.func$|_\.(py|cjs|mjs|ps1|sh)$|_verify_.*\.js$|tsc_.*\.txt$|\.pre-|\.pid$|tmp_server_clean\.sh$'

# ֻ������Щ env ģ����������� .env* һ�ɰ���
$keptEnvNames = @('.env.example', '.env.template')

function Remove-EnvFiles($path) {
    Get-ChildItem $path -Recurse -Force -File -Filter '.env*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin $keptEnvNames } |
        ForEach-Object {
            Write-Host "  [EXCLUDE] .env -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
}

function Remove-JunkFiles($path) {
    # �ݹ���������/����������v6.6 ֻ�ڶ�����ˣ���Ŀ¼���������©����������
    $junkDirs = @('__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache')
    Get-ChildItem $path -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in $junkDirs } |
        ForEach-Object {
            Write-Host "  [EXCLUDE] dir -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    Get-ChildItem $path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '\.(pyc|pyo|bak|orig|rej|log|tmp|pid)$' -or
            $_.Name -match '\.bak-' -or
            $_.Name -match '_result\.txt$' -or
            ($_.FullName -match 'tests[\\/]data[\\/].+\.json$')
        } |
        ForEach-Object {
            Write-Host "  [EXCLUDE] file -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
}

Push-Location $ProjectRoot
try {
    Write-Host "Staging project into $StageDir ..." -ForegroundColor Cyan
    Get-ChildItem $ProjectRoot -Force | Where-Object {
        $_.Name -notin $excludeDirs -and
        $_.Name -notmatch $excludeDirsRegex -and
        $_.Name -notmatch $excludeFilesRegex
    } | ForEach-Object {
        $dst = Join-Path $StageDir $_.Name
        Copy-Item $_.FullName $dst -Recurse -Force
    }

    # Strip any .env files that may have been copied under subdirectories (keep templates)
    Write-Host ""
    Write-Host "Stripping .env* from staging (keeping .env.example/.env.template)..." -ForegroundColor Cyan
    Remove-EnvFiles $StageDir

    # Strip nested build junk recursively
    Write-Host ""
    Write-Host "Stripping nested build junk..." -ForegroundColor Cyan
    Remove-JunkFiles $StageDir

    # Pack from staging root so tarball top-level is ./lingxi-engine/
    Push-Location $StageRoot
    try {
        tar czf $OutFile .
    } finally {
        Pop-Location
    }

    $sz = (Get-Item $OutFile).Length
    $mb = [math]::Round($sz / 1MB, 2)
    Write-Host ""
    Write-Host "SIZE: $sz bytes ($mb MB)" -ForegroundColor Green
    Write-Host "PATH: $OutFile" -ForegroundColor Cyan

    # Verify structure: top level should be lingxi-engine/
    Write-Host ""
    Write-Host "Verify tarball structure..." -ForegroundColor Yellow
    $top = tar -tzf $OutFile | ForEach-Object {
        $clean = $_ -replace '^\./', ''
        ($clean -split '/')[0]
    } | Sort-Object -Unique
    if ($top -contains 'lingxi-engine') {
        Write-Host "  [OK] top-level contains lingxi-engine/" -ForegroundColor Green
    } else {
        throw "[FAIL] top-level is: $($top -join ', ')"
    }

    $tarList = tar -tzf $OutFile

    # Verify no build junk leaked in
    Write-Host ""
    Write-Host "Verify no build junk..." -ForegroundColor Yellow
    $junk = $tarList | Where-Object { $_ -match '__pycache__|\.pyc$|\.bak|\.orig$|\.log$|\.tmp$|_result\.txt$|tests/data/.+\.json$' }
    if (-not $junk) {
        Write-Host "  [OK] no pyc/bak/log/result/tests-data junk in package" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] junk files found:" -ForegroundColor Red
        $junk | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
        throw "build junk must not be packaged"
    }

    # Verify .env is NOT present (templates allowed)
    Write-Host ""
    Write-Host "Verify .env is excluded..." -ForegroundColor Yellow
    $envFiles = $tarList | Select-String -Pattern '\.env' | ForEach-Object { $_.Line } |
        Where-Object { $_ -notmatch '\.env\.(example|template)$' }
    if (-not $envFiles) {
        Write-Host "  [OK] no real .env files in package" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] .env files found:" -ForegroundColor Red
        $envFiles | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
        throw ".env files must not be packaged"
    }
    $envTpl = $tarList | Where-Object { $_ -match '\.env\.example$' }
    if ($envTpl) {
        Write-Host "  [OK] .env.example present ($($envTpl[0]))" -ForegroundColor Green
    } else {
        throw "[FAIL] .env.example missing (install.sh needs it)"
    }

    # Verify key files
    Write-Host ""
    Write-Host "Verify key files..." -ForegroundColor Yellow
    $keyFiles = @('lingxi-engine/index.ts', 'lingxi-engine/src/storage/db.ts', 'lingxi-engine/src/core/router.ts', 'lingxi-engine/src/mobile/index.ts', 'lingxi-engine/web/index.html', 'lingxi-engine/web/js/app.js', 'lingxi-engine/package.json')
    foreach ($f in $keyFiles) {
        $pattern = '^\./' + [regex]::Escape($f) + '$'
        $found = $tarList | Where-Object { $_ -match $pattern }
        if ($found) {
            Write-Host "  [OK] $f" -ForegroundColor Green
        } else {
            throw "[MISSING] $f"
        }
    }

    # Verify security fixes are present
    Write-Host ""
    Write-Host "Verify v5 security fixes..." -ForegroundColor Yellow
    $platformSrc = tar -xzf $OutFile -O './lingxi-engine/src/platform-server.ts' 2>$null
    if ($platformSrc -match 'randomBytes\(16\)\.toString\(\x27hex\x27\)') {
        Write-Host "  [OK] MESH_TOKEN uses randomBytes(16).toString('hex')" -ForegroundColor Green
    } else {
        throw "[FAIL] MESH_TOKEN weak-value / randomBytes fix missing"
    }
    if ($platformSrc -match 'MESH_TOKEN_WEAK') {
        Write-Host "  [OK] weak-token detection present" -ForegroundColor Green
    } else {
        throw "[FAIL] MESH_TOKEN_WEAK missing"
    }

    $appJs = tar -xzf $OutFile -O './lingxi-engine/web/js/app.js' 2>$null
    if ($appJs -match 'LINGXI_PLATFORM_URL') {
        Write-Host "  [OK] app.js uses LINGXI_PLATFORM_URL env var" -ForegroundColor Green
    } else {
        throw "[FAIL] hardcoded platform URL still present"
    }

    $mobileSrc = tar -xzf $OutFile -O './lingxi-engine/src/mobile/index.ts' 2>$null
    if ($mobileSrc -match 'verify-email' -and $mobileSrc -match 'post') {
        Write-Host "  [OK] verify-email POST route present" -ForegroundColor Green
    } else {
        throw "[FAIL] verify-email POST route missing"
    }

    # Verify v2.0.18 platform admin features
    Write-Host ""
    Write-Host "Verify v2.0.20 platform admin..." -ForegroundColor Yellow
    $adminPage = $tarList | Where-Object { $_ -match 'platform-admin\.html$' }
    if ($adminPage) {
        Write-Host "  [OK] platform-admin.html present ($($adminPage[0]))" -ForegroundColor Green
    } else {
        throw "[FAIL] platform-admin.html missing from package"
    }
    if ($platformSrc -match 'PLATFORM_ADMIN_TOKEN') {
        Write-Host "  [OK] PLATFORM_ADMIN_TOKEN auth present" -ForegroundColor Green
    } else {
        throw "[FAIL] PLATFORM_ADMIN_TOKEN auth missing"
    }
    if ($platformSrc -match 'api/admin/users') {
        Write-Host "  [OK] admin users API present" -ForegroundColor Green
    } else {
        throw "[FAIL] admin users API missing"
    }
    if ($platformSrc -match 'api/admin/credits/grant') {
        Write-Host "  [OK] admin credits grant API present" -ForegroundColor Green
    } else {
        throw "[FAIL] admin credits grant API missing"
    }
    $pkgJson = tar -xzf $OutFile -O './lingxi-engine/package.json' 2>$null
    if ($pkgJson -match '"version":\s*"2\.0\.20"') {
        Write-Host "  [OK] package.json version = 2.0.20" -ForegroundColor Green
    } else {
        throw "[FAIL] package.json version is not 2.0.20"
    }

    # Verify v2.0.18 reasoning-stream fixes
    Write-Host ""
    Write-Host "Verify v2.0.20 reasoning stream..." -ForegroundColor Yellow
    if ($appJs -match '_lanThink' -and $appJs -match '_thinkBlock') {
        Write-Host "  [OK] app.js reasoning render markers (_lanThink/_thinkBlock)" -ForegroundColor Green
    } else {
        throw "[FAIL] app.js reasoning render markers missing"
    }
    $swJs = tar -xzf $OutFile -O './lingxi-engine/web/sw.js' 2>$null
    if ($swJs -match 'lingxi-v20') {
        Write-Host "  [OK] sw.js CACHE_NAME = lingxi-v20" -ForegroundColor Green
    } else {
        throw "[FAIL] sw.js CACHE_NAME not bumped to v20"
    }
    $indexSrc = tar -xzf $OutFile -O './lingxi-engine/index.ts' 2>$null
    if ($indexSrc -match 'credits: creditRow \? Number\(creditRow\.credits\) : 1000') {
        Write-Host "  [OK] credits ||-bug fixed (ternary guards real 0)" -ForegroundColor Green
    } else {
        throw "[FAIL] credits ||-bug fix missing from index.ts"
    }
    # scan CODE lines only: the fix comment itself mentions require('zlib') and would false-positive
    $indexCodeOnly = ( ($indexSrc -split "`n") | Where-Object { $_ -notmatch '^\s*(//|\*|/\*)' } ) -join "`n"
    if ($indexCodeOnly -match 'require\(') {
        throw "[FAIL] ESM require() landmine is BACK in index.ts (code line)"
    }
    $dbSrc = tar -xzf $OutFile -O './lingxi-engine/src/storage/db.ts' 2>$null
    if ($dbSrc -match 'credit rows backfilled') {
        Write-Host "  [OK] user_credits startup backfill present" -ForegroundColor Green
    } else {
        throw "[FAIL] credit backfill missing from db.ts"
    }
    $payClosed = ($indexSrc -match 'settle[\s\S]{0,400}?catch \(err: any\) \{ res\.status\(500\)')
    if ($payClosed) {
        Write-Host "  [OK] wallet pay/freeze/unfreeze/settle route block closed" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] could not auto-verify pay-route closure (manual check)" -ForegroundColor Yellow
    }
    $routerSrc = tar -xzf $OutFile -O './lingxi-engine/src/core/router.ts' 2>$null
    if ($routerSrc -match 'reasoning_content') {
        Write-Host "  [OK] router.ts reads reasoning/reasoning_content" -ForegroundColor Green
    } else {
        throw "[FAIL] router.ts reasoning field missing"
    }

    Write-Host ""
    Write-Host "Packaging completed successfully." -ForegroundColor Green
} finally {
    Pop-Location
    if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
