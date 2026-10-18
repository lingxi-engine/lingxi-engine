# 灵犀引擎代码备份到 F 盘（单进程 · 排除模型目录）
# 用法: powershell -ExecutionPolicy Bypass -File _backup_to_F.ps1
$ErrorActionPreference = 'Stop'

$src = 'C:\Users\Administrator\lingxi-engine'
$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
$dst = "F:\lingxi-engine-backup-$ts"

Write-Host "== 源: $src"
Write-Host "== 目标: $dst"

# 先探测 F 盘是否可读写（5 秒超时，避免卡死）
$probe = Join-Path $dst '_probe.txt'
Write-Host "== 探测 F 盘可用性..."
try {
    New-Item -ItemType Directory -Path $dst -Force -ErrorAction Stop | Out-Null
    [System.IO.File]::WriteAllText($probe, 'probe', (New-Object System.Text.UTF8Encoding($false)))
    Remove-Item $probe -Force
    Write-Host "   F 盘可写 ✓"
} catch {
    Write-Host "   ! F 盘不可写：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   ! 请先结束卡住的 Robocopy 进程（PID 25284 / 29752）或重启主机，再重跑本脚本。" -ForegroundColor Yellow
    exit 1
}

$excludeDirs = @(
    'node_modules', '.git', 'diffrhythm-local', 'workspace', 'uploads',
    'temp', 'tmp', '_archive_web_bak',
    'data-smoke-b13b', 'data-smoke-2.0.21', 'data-verify', 'data-boottest',
    'data-v36', 'data-v36local', 'data-platform', 'data-bench',
    'data-apptest', 'data-apptest2', 'data-hubtest', 'data-pctest', 'data-pcui', 'data-uitest'
)
$excludeFiles = @('*.log', '*.db-wal', '*.db-shm', '*.tmp')

$xd = @()
foreach ($d in $excludeDirs) { $xd += (Join-Path $src $d) }
# data-bench* 通配
Get-ChildItem $src -Directory -Filter 'data-bench*' -ErrorAction SilentlyContinue | ForEach-Object { $xd += $_.FullName }
Get-ChildItem $src -Directory -Filter 'data-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'data' } | ForEach-Object { if ($xd -notcontains $_.FullName) { $xd += $_.FullName } }

$args = @(
    $src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:1', '/MT:1'
)
if ($xd.Count -gt 0) { $args += '/XD'; $args += $xd }
$args += '/XF'; $args += $excludeFiles

Write-Host "== 开始复制（单线程）..."
$p = Start-Process -FilePath 'robocopy.exe' -ArgumentList $args -Wait -PassThru -NoNewWindow
$code = $p.ExitCode
Write-Host "== robocopy 退出码: $code （0/1/2/3 为成功）"

# 统计
$files = Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue
$totalMB = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "== 文件数: $($files.Count)  总大小: $totalMB MB"

# 关键文件校验
$must = @('version.txt', 'index.ts', 'src\routes\agent-grants.ts', 'web\app\grants.html', 'web\js\app.js')
foreach ($m in $must) {
    $f = Join-Path $dst $m
    if (Test-Path $f) { Write-Host "   ✓ $m" } else { Write-Host "   ✗ 缺失 $m" -ForegroundColor Yellow }
}

# SHA256 清单
$manifest = Join-Path $dst '_SHA256.txt'
$lines = Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne '_SHA256.txt' } |
    ForEach-Object { $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash; "$h  $($_.FullName.Substring($dst.Length + 1))" }
$lines | Set-Content -Path $manifest -Encoding UTF8
Write-Host "== 校验清单: $manifest ($($lines.Count) 条)"

# 备份说明
$note = Join-Path $dst '_BACKUP-INFO.txt'
@(
    "灵犀引擎备份",
    "时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "源目录: $src",
    "版本: $(Get-Content (Join-Path $src 'version.txt') -ErrorAction SilentlyContinue)",
    "文件数: $($files.Count)",
    "总大小: $totalMB MB",
    "排除: node_modules/.git/diffrhythm-local(18.5GB模型)/data-*/workspace/uploads",
    "SHA256: 见 _SHA256.txt"
) | Set-Content -Path $note -Encoding UTF8

if ($code -le 3) { Write-Host "== 备份完成 ✓" -ForegroundColor Green; exit 0 }
else { Write-Host "== 备份失败（见上方 robocopy 输出）" -ForegroundColor Red; exit $code }
