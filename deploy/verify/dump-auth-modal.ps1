$f = 'D:\lingxi-engine-oss\web\js\app.js'
$c = Get-Content $f -Raw -Encoding UTF8
$start = 171000
$len = [Math]::Min(3500, $c.Length - $start)
$snip = $c.Substring($start, $len)
$snip = $snip -replace "`r", ''
Write-Output $snip
