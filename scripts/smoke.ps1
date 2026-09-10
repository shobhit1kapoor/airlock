param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-Location $ProjectRoot

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "SMOKE FAILED: $Message" }
}

function Get-EnvFile {
  $values = @{}
  Get-Content '.env' | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object {
    $pair = $_.Split('=', 2)
    $values[$pair[0]] = $pair[1]
  }
  return $values
}

function Get-Status([string]$Uri, [hashtable]$Headers = @{}, [string]$Method = 'GET', [string]$Body = '') {
  $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers; SkipHttpErrorCheck = $true }
  if ($Body) { $params.ContentType = 'application/json'; $params.Body = $Body }
  return (Invoke-WebRequest @params).StatusCode
}

$keys = Get-EnvFile
Assert-That (-not [string]::IsNullOrWhiteSpace($keys['PLANNER_AGENT_KEY'])) 'PLANNER_AGENT_KEY is missing from .env'
Assert-That (-not [string]::IsNullOrWhiteSpace($keys['RESEARCH_AGENT_KEY'])) 'RESEARCH_AGENT_KEY is missing from .env'

Invoke-RestMethod 'http://localhost:8001/health' | Out-Null

$message = '{"jsonrpc":"2.0","id":"airlock-smoke","method":"message/send","params":{"message":{"kind":"message","messageId":"airlock-smoke","role":"user","parts":[{"kind":"text","text":"smoke validation"}]}}}'
$beforeCoding = (docker compose exec -T coding-agent python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://127.0.0.1:8030/counters'))['received'])").Trim()
$allowed = Get-Status 'http://localhost:18000/a2a/coding' @{ apikey = $keys['PLANNER_AGENT_KEY'] } 'POST' $message
Assert-That ($allowed -eq 200) 'Planner -> Coding was not delivered through Kong'
$afterAllowed = (docker compose exec -T coding-agent python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://127.0.0.1:8030/counters'))['received'])").Trim()
Assert-That ([int]$afterAllowed -eq ([int]$beforeCoding + 1)) 'Coding did not receive the allowed A2A message'

$a2a = Invoke-RestMethod -Method Post -Uri 'http://localhost:8001/api/attacks/run' -ContentType 'application/json' -Body '{"scenario":"a2a-denial"}'
Assert-That ($a2a.status -eq 403) 'Research -> Coding was not denied by Kong'
$afterDenied = (docker compose exec -T coding-agent python -c "import urllib.request,json; print(json.load(urllib.request.urlopen('http://127.0.0.1:8030/counters'))['received'])").Trim()
Assert-That ($afterDenied -eq $afterAllowed) 'Denied A2A request reached Coding upstream'

$mcp = Invoke-RestMethod -Method Post -Uri 'http://localhost:8001/api/attacks/run' -ContentType 'application/json' -Body '{"scenario":"mcp-denial"}'
Assert-That ($mcp.status -eq 403) 'Research delete_repository was not denied by Kong'
$mcpCounters = Invoke-RestMethod 'http://localhost:8010/counters'
Assert-That ($mcpCounters.delete_repository -eq 0) 'Denied delete_repository reached the MCP upstream'

$pending = Invoke-RestMethod -Method Post -Uri 'http://localhost:8001/api/attacks/run' -ContentType 'application/json' -Body '{"scenario":"approval"}'
$approved = Invoke-RestMethod -Method Post -Uri ("http://localhost:8001/api/approvals/" + $pending.id) -ContentType 'application/json' -Body '{"decision":"approve-once"}'
Assert-That ($approved.status -eq 'CONSUMED' -and $approved.remainingUses -eq 0) 'One-time approval was not consumed after create_branch'

$failover = Invoke-RestMethod -Method Post -Uri 'http://localhost:8001/api/attacks/run' -ContentType 'application/json' -Body '{"scenario":"failover"}'
Assert-That ($failover.status -eq 200) 'Kong did not continue the workflow on fallback'
Assert-That ($failover.primary.attempts -eq 1 -and $failover.primary.failures -eq 1) 'Primary adapter evidence is incorrect'
Assert-That ($failover.fallback.attempts -eq 1 -and $failover.fallback.failures -eq 0) 'Fallback adapter evidence is incorrect'

Write-Host 'Airlock smoke suite passed: MCP denial, A2A deny/allow, approval, and Kong failover.' -ForegroundColor Green
