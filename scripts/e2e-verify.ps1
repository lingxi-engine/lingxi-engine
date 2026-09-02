# E2E verify: simulate a user pulling the installer over HTTP and resolving the tarball URL
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\e2e-verify.ps1
$ErrorActionPreference = 'Stop'
$base = 'http://47.93.157.83:8080'

# 1) Pull the installer exactly like a user would
$tmp = Join-Path $env:TEMP 'e2e-install.ps1'
Invoke-WebRequest -Uri "$base/install.ps1" -OutFile $tmp -UseBasicParsing

# 2) Syntax check
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$null, [ref]$errs)
Write-Output "SYNTAX_ERRORS=$($errs.Count)"
if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Output "  LINE $($_.Extent.StartLineNumber): $($_.Message)" } }

# 3) Extract the default tarball URL from the TarballUrl line
$line = (Select-String -Path $tmp -Pattern 'TarballUrl = if').Line
$q = [char]34
$url = [regex]::Match($line, "$q([^$q]+)$q").Groups[1].Value
Write-Output "RESOLVED_URL=$url"

# 4) Verify the tarball is reachable at that URL
try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 10
    Write-Output "TARBALL_HTTP=$($r.StatusCode)"
} catch {
    Write-Output "TARBALL_HTTP=FAIL $($_.Exception.Message)"
}

# 5) Verify BOM on the served file
$bytes = [System.IO.File]::ReadAllBytes($tmp)
Write-Output "BOM=$($bytes[0]) $($bytes[1]) $($bytes[2])"

Remove-Item $tmp -Force
Write-Output 'E2E_DONE'