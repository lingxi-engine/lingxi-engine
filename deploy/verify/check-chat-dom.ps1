$root = 'https://www.lingxi-engine.com'
$c = (Invoke-WebRequest -Uri ($root + '/chat/') -UseBasicParsing -TimeoutSec 25).Content
Write-Output ("chat html len = " + $c.Length)
foreach($id in @('authUsername','authPassword','authEmail','authInviteCode','authSubmitBtn','authModal','loginButtons','loginArea','openAuthModal','showAuth')){
  $cnt = ([regex]::Matches($c, [regex]::Escape($id))).Count
  Write-Output ("  id/name '$id' -> " + $cnt)
}
Write-Output '--- buttons with onclick containing auth/login ---'
$m = [regex]::Matches($c, '(?i)<(button|a)[^>]*(onclick|id|class)="[^"]*(auth|login)[^"]*"[^>]*>')
foreach($x in $m){ Write-Output ('  ' + $x.Value.Substring(0,[Math]::Min(200,$x.Value.Length))) }
