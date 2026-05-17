$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdogScript = Join-Path $repoRoot "plugins\whatsapp-relay\scripts\controller-watchdog.mjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source

Set-Location -LiteralPath $repoRoot
& $node $watchdogScript
exit $LASTEXITCODE
