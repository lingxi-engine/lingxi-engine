$ErrorActionPreference='Continue'
$urls = @(
 '/','/chat/','/m/','/mobile.html','/register.html','/login.html','/download.html',
 '/sw.js','/manifest.json','/icons/icon-192.png','/icons/icon-512.png',
 '/css/style.css','/css/mobile.css','/js/app.js','/js/i18n.js','/platform-config.js',
 '/index.html','/chat/index.html','/privacy.html','/terms.html','/robots.txt','/sitemap.xml',
 '/public/lingxi-engine.tar.gz','/api/health','/icon.svg','/favicon.ico'
)
$fail = @()
foreach($p in $urls){
  $code = 0
  try {
    $r = Invoke-WebRequest -Uri ('https://www.lingxi-engine.com'+$p) -Method Get -MaximumRedirection 0 -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    $code = [int]$r.StatusCode
  } catch {
    if($_.Exception.Response){ $code = [int]$_.Exception.Response.StatusCode } else { $code = -1 }
  }
  $flag = if($code -eq 200){'OK '} else {'FAIL'}
  Write-Output ("{0} {1,-38} {2}" -f $flag,$p,$code)
  if($code -ne 200){ $fail += ($p + ' => ' + $code) }
}
Write-Output "=================================="
if($fail.Count -eq 0){ Write-Output "ALL 200 - PASS" } else { Write-Output ("FAILED: " + ($fail -join ' | ')) }
