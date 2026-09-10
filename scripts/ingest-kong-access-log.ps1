param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

# Tails the local Kong data-plane access log and forwards only parsed Kong log
# records to Airlock. This is intentionally separate from application traffic:
# events originate in Kong's own access log and carry kong_request_id.
$ErrorActionPreference = 'Stop'
Set-Location $ProjectRoot
$values = @{}
Get-Content '.env' | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object {
  $pair = $_.Split('=', 2); $values[$pair[0]] = $pair[1]
}
$token = $values['KONG_TELEMETRY_TOKEN']
if ([string]::IsNullOrWhiteSpace($token)) { $token = 'airlock-local-telemetry-token' }

docker logs --follow --since 0s airlock-gateway 2>&1 | ForEach-Object {
  $line = $_.ToString()
  if ($line -match '"(?<method>[A-Z]+) (?<path>[^ ]+) HTTP/[^\"]+" (?<status>\d+) .*kong_request_id: "(?<id>[^"]+)"') {
    $payload = @{ kong_request_id = $Matches.id; request = @{ method = $Matches.method; uri = $Matches.path }; response = @{ status = [int]$Matches.status }; observed_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5 -Compress
    try {
      Invoke-RestMethod -Method Post -Uri 'http://localhost:8001/api/telemetry/kong' -Headers @{ 'X-Airlock-Telemetry-Token' = $token } -ContentType 'application/json' -Body $payload | Out-Null
    } catch { Write-Warning "Unable to forward Kong log entry: $($_.Exception.Message)" }
  }
}
