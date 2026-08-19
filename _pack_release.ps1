$ErrorActionPreference = 'Stop'
Set-Location c:\Users\Administrator\lingxi-engine
$out = Join-Path $env:TEMP 'lingxi-engine-v2.0.12.tar.gz'
if (Test-Path $out) { Remove-Item $out -Force }
& "$env:SystemRoot\System32\tar.exe" --exclude='./node_modules' --exclude='./.git' --exclude='*.tar.gz' --exclude='*.zip' --exclude='*.exe' --exclude='*.bak*' --exclude='*.old' --exclude='*.png' --exclude='*.pre-platform-*' --exclude='server_restart.log' --exclude='_*.cjs' --exclude='_*.txt' --exclude='ecosystem.config.cjs' --exclude='*_cleanup-bak-*' --exclude='*_rollback-*' --exclude='web_backup_v9' --exclude='diffrhythm-local' --exclude='workspace' --exclude='docs' --exclude='data' --exclude='uploads' --exclude='song_maker' --exclude='_verify_tmp' --exclude='src/src' --exclude='mobile-dist' --exclude='mobile' --exclude='app' --exclude='usage.json' --exclude='tmp_*' --exclude='check_fix*' --exclude='inspect_chat*' --exclude='grep_db_persist.py' --exclude='_bak_*' --exclude='_verify_pack.ps1' --exclude='_secfix_backup_*' --exclude='*.FINAL-*' --exclude='2026*' -czf $out -C c:\Users\Administrator\lingxi-engine .
$sz = (Get-Item $out).Length
Write-Host ("SIZE: {0} bytes ({1:N2} MB)" -f $sz, ($sz/1MB))
Write-Host "PATH: $out"
