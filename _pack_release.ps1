# 灵犀引擎打包脚本
# 用法: powershell -ExecutionPolicy Bypass -File .\_pack_release.ps1
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutFile = Join-Path $env:TEMP "lingxi-engine-v2.0.12.tar.gz"

# 排除规则（注意：--exclude=storage 会匹配 src/storage/，必须用精确路径）
$excludes = @(
    '--exclude=./node_modules',
    '--exclude=./.git',
    '--exclude=./workspace',
    '--exclude=./data',
    '--exclude=./docs',
    '--exclude=./mobile-dist',
    '--exclude=./mobile',
    '--exclude=./app',
    '--exclude=./diffrhythm-local',
    '--exclude=./song_maker',
    '--exclude=./_verify_tmp',
    # storage/ uploads/ 是空的运行时目录，不排除（避免误杀 src/storage/）
    '--exclude=*.bak*',
    '--exclude=*.log',
    '--exclude=*.tmp',
    '--exclude=patch-db.cjs',
    '--exclude=startup.err',
    '--exclude=./_archive',
    '--exclude=./_junk*'
)

# 打包
Push-Location $ProjectRoot
try {
    tar czf $OutFile @excludes -C "." .
    $sz = (Get-Item $OutFile).Length
    $mb = [math]::Round($sz / 1MB, 2)
    Write-Host "SIZE: $sz bytes ($mb MB)" -ForegroundColor Green
    Write-Host "PATH: $OutFile" -ForegroundColor Cyan

    # 验证关键文件
    Write-Host "`n验证关键文件..." -ForegroundColor Yellow
    $keyFiles = @('index.ts', 'src/storage/db.ts', 'src/core/router.ts', 'web/index.html', 'package.json')
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
