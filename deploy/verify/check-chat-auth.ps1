$f = 'D:\lingxi-engine-oss\web\js\app.js'
$c = Get-Content $f -Raw -Encoding UTF8
Write-Output ("file len = " + $c.Length)

$pats = @('login\.html','register\.html','authToken','/api/auth/','shouldLogin','needLogin')
foreach($p in $pats){
  $ms = [regex]::Matches($c, $p)
  Write-Output ("--- pattern: $p  hits=" + $ms.Count + " ---")
  $n = 0
  foreach($m in $ms){
    $n++
    if($n -gt 3){ break }
    $s = [Math]::Max(0, $m.Index - 150)
    $len = [Math]::Min(300, $c.Length - $s)
    $snip = $c.Substring($s, $len)
    $snip = $snip -replace "`r", ' '
    $snip = $snip -replace "`n", ' '
    Write-Output ("   at " + $m.Index + " : " + $snip)
  }
}
