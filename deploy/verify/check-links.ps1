$ErrorActionPreference='Continue'
$root = 'https://www.lingxi-engine.com'

function Get-Page($p){
  try { return (Invoke-WebRequest -Uri ($root+$p) -UseBasicParsing -TimeoutSec 20).Content } catch { return '' }
}

Write-Output '=== download.html 里的链接 ==='
$d = Get-Page '/download.html'
$m = [regex]::Matches($d,'(?i)href\s*=\s*["'']([^"'']+)["'']')
$hrefs = $m | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach($h in $hrefs){ Write-Output ("  href: " + $h) }
Write-Output ("  空链 href='#' 数量: " + ([regex]::Matches($d,'href\s*=\s*["'']#["'']')).Count)

Write-Output ''
Write-Output '=== 下载页指向的目标是否真实存在 ==='
foreach($h in $hrefs){
  if($h -match '^https?://' -or $h -eq '#' -or $h.StartsWith('mailto')){ continue }
  $u = if($h.StartsWith('/')){ $root+$h } else { $root+'/'+$h }
  $code = 0
  try { $code = [int](Invoke-WebRequest -Uri $u -Method Head -UseBasicParsing -TimeoutSec 15).StatusCode }
  catch { if($_.Exception.Response){ $code = [int]$_.Exception.Response.StatusCode } else { $code = -1 } }
  Write-Output ("  {0,4}  {1}" -f $code, $u)
}

Write-Output ''
Write-Output '=== robots.txt ==='
Write-Output (Get-Page '/robots.txt')

Write-Output '=== sitemap.xml (前 600 字符) ==='
$sm = Get-Page '/sitemap.xml'
Write-Output $sm.Substring(0,[Math]::Min(600,$sm.Length))
Write-Output ("  loc 数量: " + ([regex]::Matches($sm,'<loc>')).Count)

Write-Output ''
Write-Output '=== 聊天页是否含注册/登录入口（未登录引导） ==='
$c = Get-Page '/chat/'
Write-Output ("  register.html 出现: " + ([regex]::Matches($c,'register\.html')).Count)
Write-Output ("  login.html 出现:    " + ([regex]::Matches($c,'login\.html')).Count)
Write-Output ("  注册字样:           " + ([regex]::Matches($c,'注册')).Count)
Write-Output ("  登录字样:           " + ([regex]::Matches($c,'登录')).Count)
