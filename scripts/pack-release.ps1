# Lingxi Engine pack script v6.8 (2026-09-14: assertions -> v2.0.20/sw-v20 + credit-backfill/no-require guards (v6.7 2026-09-12: 锟睫革拷嵌锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷 + 锟斤拷锟斤拷 .env 模锟斤拷)
#   v6.7 锟斤拷锟?
#     - 锟斤拷锟斤拷 Remove-JunkFiles: 锟捷癸拷锟斤拷锟斤拷 __pycache__/*.pyc/*.bak*/_result.txt/tests/data/*.json
#       (v6.6 锟斤拷 $excludeFilesRegex 只锟斤拷锟斤拷锟节讹拷锟姐，锟斤拷锟斤拷 src/锟斤拷lingxi_engine/ 锟节碉拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?
#     - Remove-EnvFiles 锟斤拷为锟斤拷锟斤拷 .env.example / .env.template锟斤拷install.sh 锟斤拷锟斤拷 .env.example锟斤拷
#     - 锟斤拷锟斤拷: 锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷锟叫ｏ拷锟?+ .env.example 锟斤拷锟斤拷锟斤拷校锟斤拷
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\pack-release.ps1
$ErrorActionPreference = "Stop"
# v7.4 (2026-11-24): Windows tar compatibility shim.
# System32 tar.exe is bsdtar (built-in gzip, rejects --force-local).
# Git's GNU tar needs --force-local for drive-colon paths, but its -z spawns
# gzip via /bin/sh which can fail with "gzip: command not found" under an
# incomplete MSYS child PATH. This function shadows `tar` for every call site
# below: strip --force-local for bsdtar, keep it (with PATH fix) for GNU tar.
function tar {
    $tarArgs = @($args | Where-Object { $_ -ne '--force-local' })
    $bsdtar = Join-Path $env:SystemRoot 'System32\tar.exe'
    $gnuTar = 'C:\Program Files\Git\usr\bin\tar.exe'
    if (Test-Path $bsdtar) {
        & $bsdtar @tarArgs
    } elseif (Test-Path $gnuTar) {
        $env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
        & $gnuTar --force-local @tarArgs
    } else {
        & tar.exe @tarArgs
    }
}

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# v2.0.22: 鐗堟湰浠?package.json 鍔ㄦ€佽鍙栵紝绂佹纭紪鐮侊紙姝ゅ墠纭紪鐮?2.0.20锛屽崌鐗堝悗蹇?FAIL锛?
$Version = (Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Version) { throw '[FAIL] cannot read version from package.json' }
$Commit = ''; try { $Commit = (git -C $ProjectRoot rev-parse --short HEAD).Trim() } catch { $Commit = 'unknown' }
$OutFile = Join-Path $env:TEMP "lingxi-engine-v$Version.tar.gz"

# Stage into a temp dir with lingxi-engine/ prefix so install.ps1 finds the inner dir
$StageRoot = Join-Path $env:TEMP "lingxi-engine-staging-$(Get-Random)"
$StageDir = Join-Path $StageRoot "lingxi-engine"
if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

$excludeDirs = @('node_modules','coverage','.git','workspace','data','data-platform','docs','mobile-dist','app','diffrhythm-local','song_maker','_verify_tmp','_release_check','_pkgx','backup_20260825_reasoning','data-smoke-b13b','_smoke_v5_data','_archive','release','release-v2','stage')
$excludeDirsRegex = '^backup[_-]|^data-bench|^data-|^_|^archive[_-]'  # v2.0.35: exclude archive_scratch_* junk (3.9MB screenshots)
$excludeFilesRegex = '\.tar\.gz$|\.bak|\.orig$|\.zip$|_cleanup-bak-|\.patch-ctor|fix-task-interrupt.*\.cjs|fix-install\.cjs$|patch-admin\.|\.log$|\.err$|^e2e-|\.tmp$|patch-db\.cjs|startup\.err|usage\.json$|\.func$|_\.(py|cjs|mjs|ps1|sh)$|_verify_.*\.js$|tsc_.*\.txt$|\.pre-|\.pid$|tmp_server_clean\.sh$|^_|^fo_main\.txt$'

# 只锟斤拷锟斤拷锟斤拷些 env 模锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?.env* 一锟缴帮拷锟斤拷
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
    # 锟捷癸拷锟斤拷锟斤拷锟斤拷锟斤拷/锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷v6.6 只锟节讹拷锟斤拷锟斤拷耍锟斤拷锟侥柯硷拷锟斤拷锟斤拷锟斤拷锟斤拷漏锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
    $junkDirs = @('__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache')
    Get-ChildItem $path -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in $junkDirs } |
        ForEach-Object {
            Write-Host "  [EXCLUDE] dir -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    # v7.3 (2026-11-18): secrets + runtime state must never ship in the public tarball.
    # .dbkey = per-machine DB encryption key (auto-generated on first start, see field-crypto.ts).
    # lingxi_engine/data/ = dev-machine runtime outputs (dream queue, parliament records...).
    Get-ChildItem $path -Recurse -Force -File -Filter '.dbkey' -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host "  [EXCLUDE] secret -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
    Get-ChildItem $path -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'lingxi_engine[\\/]data$' } |
        ForEach-Object {
            Write-Host "  [EXCLUDE] runtime-data -> $($_.FullName)" -ForegroundColor DarkGray
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    Get-ChildItem $path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '\.(pyc|pyo|bak|orig|rej|log|tmp|pid)$' -or
            $_.Name -match '\.bak-' -or
            $_.Name -match '_result\.txt$' -or
            $_.Name -in @('600', 'nohup.out', 'cookies.txt') -or
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

    # v2.0.22: 鍐欏叆鏋勫缓淇℃伅锛堢増鏈?+ commit锛夛紝渚涚嚎涓?/api/health 姣斿
    # v6.9 (2026-10-01): 保留人工字段。
    #   原实现用四字段整体覆写，把 highlights / quality / commitMeaning 冲掉，
    #   于是每次打包都会静默丢失发布说明（对外解释「这版改了什么」的唯一来源）。
    #   现在：version / commit / buildTime / builder 由脚本权威写入，
    #   其余人工字段从既有 BUILD-INFO.json 继承。
    $buildInfo = [ordered]@{
        version   = $Version
        commit    = $Commit
        buildTime = (Get-Date).ToUniversalTime().ToString('o')
        builder   = 'pack-release.ps1'
    }
    $rootBiExisting = Join-Path $ProjectRoot 'BUILD-INFO.json'
    if (Test-Path $rootBiExisting) {
        try {
            # 必须显式 -Encoding UTF8。Windows PowerShell 5.1 的 Get-Content 默认按
            # 系统 ANSI 代码页读文件，而本文件是【无 BOM 的 UTF-8】——
            # highlights 全是中文，按 ANSI 读进来即乱码，ConvertFrom-Json 直接抛错，
            # 于是落进 catch，人工字段被静默丢弃。日志里的
            # "[WARN] 既有 BUILD-INFO.json 解析失败" 就是它的指纹。
            $prev = Get-Content $rootBiExisting -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in @('highlights','quality','commitMeaning','notes')) {  # v2.0.35: notes was silently dropped on every repack
                if ($prev.PSObject.Properties.Name -contains $k) { $buildInfo[$k] = $prev.$k }
            }
        } catch {
            Write-Host "  [WARN] 既有 BUILD-INFO.json 解析失败，仅写入基础字段" -ForegroundColor Yellow
        }
    }
    $buildInfoJson = $buildInfo | ConvertTo-Json -Depth 6
    # v6.9: PowerShell 'Set-Content -Encoding UTF8' emits a BOM (EF BB BF), which breaks
    # strict JSON parsers on the server. Write UTF8 WITHOUT BOM via .NET instead.
    [System.IO.File]::WriteAllText((Join-Path $StageDir 'BUILD-INFO.json'), $buildInfoJson, (New-Object System.Text.UTF8Encoding $false))
    # v7.0: also refresh the TRACKED project-root copy. Previously only the staging
    # copy was written, so the repo-root BUILD-INFO.json stayed frozen at an older
    # version and reported misleading build metadata. Refresh both, always.
    [System.IO.File]::WriteAllText((Join-Path $ProjectRoot 'BUILD-INFO.json'), $buildInfoJson, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  [OK] BUILD-INFO.json refreshed at project root" -ForegroundColor Green
    Write-Host "  [OK] BUILD-INFO.json written (version=$Version commit=$Commit)" -ForegroundColor Green

    # Pack from staging root so tarball top-level is ./lingxi-engine/
    Push-Location $StageRoot
    try {
        # v7.4 (2026-11-24): tar compatibility on Windows.
        # - System32 tar.exe is bsdtar: built-in gzip, rejects --force-local.
        # - Git's GNU tar needs --force-local (drive colon) AND spawns gzip via
        #   /bin/sh, which fails with "gzip: command not found" when the MSYS
        #   child PATH is incomplete.
        # Prefer native bsdtar; GNU tar is the fallback with PATH prepended.
        $bsdtar = Join-Path $env:SystemRoot 'System32\tar.exe'
        $gnuTar = 'C:\Program Files\Git\usr\bin\tar.exe'
        if (Test-Path $bsdtar) {
            & $bsdtar -czf $OutFile .
        } elseif (Test-Path $gnuTar) {
            $env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
            & $gnuTar --force-local -czf $OutFile .
        } else {
            tar -czf $OutFile .
        }
        if ($LASTEXITCODE -ne 0) { throw "[FAIL] tar exited with code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $sz = (Get-Item $OutFile).Length
    $mb = [math]::Round($sz / 1MB, 2)
    Write-Host ""
    Write-Host "SIZE: $sz bytes ($mb MB)" -ForegroundColor Green
    Write-Host "PATH: $OutFile" -ForegroundColor Cyan

    # v7.1 (2026-10-02): SIZE GATE. A hand-run `tar` without the exclude lists once
    # produced a 26MB public artifact that shipped a 52MB stale test DB to every
    # downloader. Nothing asserted a ceiling, so the bloat passed unnoticed. Fail loudly
    # instead - a package above this is almost always junk directories the exclude lists
    # failed to match. NOTE: $excludeDirsRegex is only applied to TOP-LEVEL names, so a
    # nested junk dir (e.g. web/data-bench/) slips straight through to the tarball.
    $MaxPackageMB = 12
    if ($mb -gt $MaxPackageMB) {
        Write-Host ""
        Write-Host "  [FAIL] package is $mb MB, above the $MaxPackageMB MB ceiling" -ForegroundColor Red
        Write-Host "         largest entries in the artifact:" -ForegroundColor Red
        tar --force-local -tzvf $OutFile | ForEach-Object {
            $parts = $_ -split '\s+', 6
            $size = 0
            [void][int64]::TryParse($parts[2], [ref]$size)
            New-Object PSObject -Property @{ Size = $size; Line = $_ }
        } | Sort-Object Size -Descending | Select-Object -First 15 |
            ForEach-Object { Write-Host "         $($_.Line)" -ForegroundColor Red }
        throw "[FAIL] package too large ($mb MB > $MaxPackageMB MB) - junk directories leaked into staging"
    }

    # Verify structure: top level should be lingxi-engine/
    Write-Host ""
    Write-Host "Verify tarball structure..." -ForegroundColor Yellow
    $top = tar --force-local -tzf $OutFile | ForEach-Object {
        $clean = $_ -replace '^\./', ''
        ($clean -split '/')[0]
    } | Sort-Object -Unique
    if ($top -contains 'lingxi-engine') {
        Write-Host "  [OK] top-level contains lingxi-engine/" -ForegroundColor Green
    } else {
        throw "[FAIL] top-level is: $($top -join ', ')"
    }

    $tarList = tar --force-local -tzf $OutFile

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

    # v7.3: secrets / runtime-state leak gate
    $secretLeak = $tarList | Where-Object { $_ -match '\.dbkey$|lingxi_engine/data/|(^|/)600$|nohup\.out$' }
    if ($secretLeak) {
        Write-Host "  [FAIL] secrets/runtime state leaked into package:" -ForegroundColor Red
        $secretLeak | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
        throw ".dbkey / lingxi_engine runtime data / cookie junk must not be packaged"
    }
    Write-Host "  [OK] no .dbkey / runtime-state / cookie-junk leak" -ForegroundColor Green

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

    # install scripts must be tracked in site/ and shipped in the tarball
    foreach ($sf in @("site/install.sh", "site/install.ps1")) {
        $sfEntry = $tarList | Where-Object { $_ -match [regex]::Escape("lingxi-engine/$sf") }
        if (-not $sfEntry) { throw "[FAIL] $sf not in tarball (publish uploads it - add site/ to staging)" }
        Write-Host "  [OK] $sf in package ($($sfEntry[0]))" -ForegroundColor Green
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
    $platformSrc = tar --force-local -xzf $OutFile -O './lingxi-engine/src/platform-server.ts' 2>$null
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

    $appJs = tar --force-local -xzf $OutFile -O './lingxi-engine/web/js/app.js' 2>$null
    if ($appJs -match 'LINGXI_PLATFORM_URL') {
        Write-Host "  [OK] app.js uses LINGXI_PLATFORM_URL env var" -ForegroundColor Green
    } else {
        throw "[FAIL] hardcoded platform URL still present"
    }

    $mobileSrc = tar --force-local -xzf $OutFile -O './lingxi-engine/src/mobile/index.ts' 2>$null
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
    $pkgJson = tar --force-local -xzf $OutFile -O './lingxi-engine/package.json' 2>$null
    $verPat = '"version":\s*"' + [regex]::Escape($Version) + '"'
    if ($pkgJson -match $verPat) {
        Write-Host "  [OK] package.json version = $Version" -ForegroundColor Green
    } else {
        throw "[FAIL] package.json version is not $Version"
    }

    # Verify v2.0.18 reasoning-stream fixes
    Write-Host ""
    Write-Host "Verify v2.0.20 reasoning stream..." -ForegroundColor Yellow
    if ($appJs -match '_lanThink' -and $appJs -match '_thinkBlock') {
        Write-Host "  [OK] app.js reasoning render markers (_lanThink/_thinkBlock)" -ForegroundColor Green
    } else {
        throw "[FAIL] app.js reasoning render markers missing"
    }
    $swJs = tar --force-local -xzf $OutFile -O './lingxi-engine/web/sw.js' 2>$null
    if ($swJs -match 'lingxi-v2\d') {
        Write-Host "  [OK] sw.js CACHE_NAME = lingxi-v2\d" -ForegroundColor Green
    } else {
        throw "[FAIL] sw.js CACHE_NAME not bumped to v20"
    }
    $indexSrc = tar --force-local -xzf $OutFile -O './lingxi-engine/index.ts' 2>$null
    # v6.9 (2026-10-01): 自适应断言。
    #   历史背景：credits/wallet 功能已随 marketplace 下线（969b385）整段移除，
    #   原断言仍在检查那段代码的实现细节，于是永久失败并阻断发布。
    #   现在按功能存废分流；若 credits 功能回归，守卫检查会自动重新生效
    #   （真实 0 被 || 1000 吞掉是个真 bug，必须挡住）。
    if ($indexSrc -match 'creditRow') {
        if ($indexSrc -match 'credits: creditRow \? Number\(creditRow\.credits\) : 1000') {
            Write-Host "  [OK] credits ||-bug fixed (ternary guards real 0)" -ForegroundColor Green
        } else {
            throw "[FAIL] credits feature present but ||-bug guard missing from index.ts"
        }
    } else {
        Write-Host "  [SKIP] credits/wallet 已随 marketplace 下线（969b385），对应的 ||-bug 守卫断言不适用" -ForegroundColor DarkGray
    }
    # scan CODE lines only: the fix comment itself mentions require('zlib') and would false-positive
    $indexCodeOnly = ( ($indexSrc -split "`n") | Where-Object { $_ -notmatch '^\s*(//|\*|/\*)' } ) -join "`n"
    if ($indexCodeOnly -match 'require\(') {
        throw "[FAIL] ESM require() landmine is BACK in index.ts (code line)"
    }
    $dbSrc = tar --force-local -xzf $OutFile -O './lingxi-engine/src/storage/db.ts' 2>$null
    # v7.2 (2026-11-15): 自适应断言（同 v6.9 credits ||-bug 守卫先例）。
    #   credits/wallet 已随 marketplace 下线（969b385），user_credits 表与 backfill
    #   代码整段移除，原断言永久失败阻断发布。按功能存废分流；若 credits 回归，
    #   守卫自动重新生效。
    if ($dbSrc -match 'user_credits') {
        if ($dbSrc -match 'credit rows backfilled') {
            Write-Host "  [OK] user_credits startup backfill present" -ForegroundColor Green
        } else {
            throw "[FAIL] credits feature present but backfill missing from db.ts"
        }
    } else {
        Write-Host "  [SKIP] credits/wallet 已随 marketplace 下线（969b385），backfill 断言不适用" -ForegroundColor DarkGray
    }
    $payClosed = ($indexSrc -match 'settle[\s\S]{0,400}?catch \(err: any\) \{ res\.status\(500\)')
    if ($payClosed) {
        Write-Host "  [OK] wallet pay/freeze/unfreeze/settle route block closed" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] could not auto-verify pay-route closure (manual check)" -ForegroundColor Yellow
    }
    $routerSrc = tar --force-local -xzf $OutFile -O './lingxi-engine/src/core/router.ts' 2>$null
    if ($routerSrc -match 'reasoning_content') {
        Write-Host "  [OK] router.ts reads reasoning/reasoning_content" -ForegroundColor Green
    } else {
        throw "[FAIL] router.ts reasoning field missing"
    }

    Write-Host ""
    Write-Host "Verify BUILD-INFO.json..." -ForegroundColor Yellow
    # v7.1 (2026-10-02): this check had been failing on EVERY release that carried a
    # Chinese-containing BUILD-INFO.json, and nobody noticed. Two stacked causes:
    #   1. `tar -xzf ... -O` piped into a cmdlet makes PowerShell decode the native
    #      stdout with the console output encoding, so UTF-8 Chinese becomes mojibake
    #      (including a byte-truncated quote) BEFORE Set-Content ever sees it;
    #   2. the earlier `| ConvertFrom-Json` on that mangled string then threw
    #      "invalid character, expecting ...".
    # Fix: never pipe native stdout into a cmdlet. Extract the member to a real temp
    # file with tar -C and read the bytes explicitly as UTF-8. Same reason
    # publish-site.ps1 refuses to read .env through a pipe.
    $biExtractDir = Join-Path $env:TEMP "lingxi-bi-extract-$(Get-Random)"
    New-Item -ItemType Directory -Path $biExtractDir -Force | Out-Null
    $bi = $null
    try {
        tar --force-local -xzf $OutFile -C $biExtractDir './lingxi-engine/BUILD-INFO.json' 2>$null
        $biFile = Join-Path $biExtractDir 'lingxi-engine\BUILD-INFO.json'
        if (Test-Path $biFile) {
            $biText = [System.IO.File]::ReadAllText($biFile, (New-Object System.Text.UTF8Encoding $false))
            if ($biText.Trim()) { $bi = $biText | ConvertFrom-Json }
        }
    } finally {
        Remove-Item $biExtractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($bi) {
        if ($bi.version -eq $Version) {
            Write-Host "  [OK] BUILD-INFO version = $Version" -ForegroundColor Green
        } else {
            throw "[FAIL] BUILD-INFO version ($($bi.version)) != $Version"
        }
        Write-Host "  [OK] BUILD-INFO commit = $($bi.commit)" -ForegroundColor Green
        Write-Host "  [OK] BUILD-INFO highlights parsed as UTF-8 ($($bi.highlights.Count) items)" -ForegroundColor Green
        $rootBiPath = Join-Path $ProjectRoot 'BUILD-INFO.json'
        if (Test-Path $rootBiPath) {
            $rootBi = Get-Content $rootBiPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($rootBi.version -eq $Version) {
                Write-Host "  [OK] root BUILD-INFO.json in sync ($Version)" -ForegroundColor Green
            } else {
                throw "[FAIL] root BUILD-INFO.json version ($($rootBi.version)) != $Version"
            }
        } else {
            throw "[FAIL] root BUILD-INFO.json missing"
        }
    } else {
        throw '[FAIL] BUILD-INFO.json missing or unparseable in package'
    }

    Write-Host "Packaging completed successfully." -ForegroundColor Green
} finally {
    Pop-Location
    if (Test-Path $StageRoot) { Remove-Item $StageRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
