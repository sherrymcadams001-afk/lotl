param(
  [int]$ControllerPort = 3000,
  [int]$ChromePort = 9222,
  [Alias('Host')]
  [string]$BindHost = '127.0.0.1',
  [ValidateSet('normal','single','multi')]
  [string]$Mode = 'normal',
  [string]$UserDataDir = '',
  [string]$NodePath = '',
  [string]$ChromePath = '',
  [int]$WaitReadySec = 180
)

$ErrorActionPreference = 'Stop'

function Resolve-NodePath([string]$Explicit) {
  if ($Explicit -and (Test-Path $Explicit)) { return $Explicit }
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  throw 'Node.js not found. Install Node 18+ or pass -NodePath.'
}

function Stop-ListenerOnPort([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}

function Wait-Ready([string]$BaseUrl, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -Uri "$BaseUrl/ready" -TimeoutSec 10
      if ($r.ok -eq $true) { return $true }
    } catch {
      # ignore
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$node = Resolve-NodePath -Explicit $NodePath

if (-not $UserDataDir -or $UserDataDir.Trim().Length -eq 0) {
  $base = $env:LOCALAPPDATA
  if (-not $base -or $base.Trim().Length -eq 0) {
    $base = $env:TEMP
  }
  $UserDataDir = Join-Path $base ("LotL\\chrome-lotl-" + $ChromePort)
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

Stop-ListenerOnPort -Port $ControllerPort

# 1) Launch Chrome (detached)
$launchArgs = @('scripts\launch-chrome.js', '--chrome-port', $ChromePort, '--user-data-dir', $UserDataDir)
if ($ChromePath -and $ChromePath.Trim().Length -gt 0) {
  $env:CHROME_PATH = $ChromePath
}
Start-Process -FilePath $node -WorkingDirectory $root -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null

# 2) Start controller (detached, with logs)
$out = Join-Path $root ("controller_${ControllerPort}.out.log")
$err = Join-Path $root ("controller_${ControllerPort}.err.log")
$ctrlArgs = @('scripts\start-controller.js','--host',$BindHost,'--port',$ControllerPort,'--chrome-port',$ChromePort,'--mode',$Mode)
Start-Process -FilePath $node -WorkingDirectory $root -ArgumentList $ctrlArgs -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null

$base = "http://${BindHost}:${ControllerPort}"
Write-Host "Started controller: $base (Chrome CDP: $ChromePort)"
Write-Host "Logs: $out , $err"

if (-not (Wait-Ready -BaseUrl $base -TimeoutSec $WaitReadySec)) {
  Write-Host "WARNING: /ready did not become ok within ${WaitReadySec}s."
  Write-Host "Open Chrome (CDP $ChromePort), sign in to AI Studio, and ensure a chat prompt box is visible." 
  exit 2
}

Write-Host "READY ok: $base/ready"
