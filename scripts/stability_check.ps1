param(
  [Alias('BaseUrl')][string]$ControllerUrl = 'http://127.0.0.1:3000',
  [int]$Count = 8,
  [int]$DelayMs = 0,
  [int]$TimeoutSec = 360,
  [ValidateSet('aistudio','gemini','chatgpt','chat')][string]$Target = 'aistudio'
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonGet([string]$Url, [int]$TimeoutSecLocal) {
  try {
    return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec $TimeoutSecLocal
  } catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      throw "GET $Url failed: $($_.Exception.Message) :: $($_.ErrorDetails.Message)"
    }
    throw "GET $Url failed: $($_.Exception.Message)"
  }
}

function Invoke-JsonPost([string]$Url, [object]$BodyObj, [int]$TimeoutSecLocal) {
  $json = $BodyObj | ConvertTo-Json -Depth 6
  try {
    return Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $json -TimeoutSec $TimeoutSecLocal
  } catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      throw "POST $Url failed: $($_.Exception.Message) :: $($_.ErrorDetails.Message)"
    }
    throw "POST $Url failed: $($_.Exception.Message)"
  }
}

$healthUrl = "$ControllerUrl/health"
$readyUrl  = "$ControllerUrl/ready"

Write-Host "health: $healthUrl"
$health = Invoke-JsonGet -Url $healthUrl -TimeoutSecLocal 5
$health | ConvertTo-Json -Depth 4 | Write-Host

Write-Host "ready:  $readyUrl"
try {
  $ready = Invoke-JsonGet -Url $readyUrl -TimeoutSecLocal 10
  $ready | ConvertTo-Json -Depth 8 | Write-Host
} catch {
  Write-Host "READY FAILED: $_"
  exit 2
}

$endpoint = if ($Target -eq 'chat') { "$ControllerUrl/chat" } else { "$ControllerUrl/$Target" }
Write-Host "endpoint: $endpoint"

$results = @()
for ($i = 1; $i -le $Count; $i++) {
  if ($DelayMs -gt 0 -and $i -gt 1) {
    Start-Sleep -Milliseconds $DelayMs
  }
  $expected = "OK-$i"

  $body = if ($Target -eq 'chat') {
    @{ target = 'gemini'; prompt = "Reply with exactly: $expected" }
  } else {
    @{ prompt = "Reply with exactly: $expected" }
  }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-JsonPost -Url $endpoint -BodyObj $body -TimeoutSecLocal $TimeoutSec
    $sw.Stop()

    $reply = [string]($resp.reply)
    $replyTrim = ($reply | ForEach-Object { if ($_ -eq $null) { '' } else { $_ } }).Trim()
    # Stability check should be strict: exact token only.
    $matched = ($resp.success -eq $true) -and ($replyTrim -ceq $expected)

    $results += [pscustomobject]@{
      i       = $i
      seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
      success = [bool]$resp.success
      matched = [bool]$matched
      reply   = ($replyTrim -replace '\s+', ' ').Substring(0, [Math]::Min(140, ($replyTrim -replace '\s+', ' ').Length))
    }

    Write-Host "#$i ${($sw.Elapsed.TotalSeconds.ToString('0.0'))}s matched=$matched"
  } catch {
    $sw.Stop()
    $results += [pscustomobject]@{ i=$i; seconds=[Math]::Round($sw.Elapsed.TotalSeconds,2); success=$false; matched=$false; reply=[string]$_ }
    Write-Host "#$i ERROR: $_"
  }
}

$results | Format-Table -AutoSize
$pass = ($results | Where-Object { $_.matched }).Count
$fail = $Count - $pass
$avg = [Math]::Round((($results | Measure-Object -Property seconds -Average).Average), 2)
Write-Host "pass=$pass fail=$fail avgSeconds=$avg"
if ($fail -gt 0) { exit 1 }
