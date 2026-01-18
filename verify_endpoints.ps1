# Verifies LotL Controller v3 endpoints.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\verify_endpoints.ps1

$base = "http://127.0.0.1:3000"

Write-Host "Testing $base/health" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 5
  $h | ConvertTo-Json -Depth 6
} catch {
  Write-Error $_
  exit 1
}

Write-Host "Testing $base/ready" -ForegroundColor Cyan
try {
  $r = Invoke-RestMethod -Uri "$base/ready" -Method Get -TimeoutSec 10
  $r | ConvertTo-Json -Depth 8
} catch {
  Write-Error $_
}

Write-Host "Testing $base/aistudio (text-only)" -ForegroundColor Cyan
$body = @{ prompt = "Say 'ok' exactly." } | ConvertTo-Json
try {
  $resp = Invoke-RestMethod -Uri "$base/aistudio" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
  $resp | ConvertTo-Json -Depth 8
} catch {
  Write-Error $_
}

Write-Host "Done." -ForegroundColor Green
