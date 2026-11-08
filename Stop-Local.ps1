param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$runtimeDir = Split-Path -Parent (Resolve-Path -LiteralPath $ConfigPath).Path
$pidFile = Join-Path $runtimeDir 'processes.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No saved Smena processes.'; exit }
$saved = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
foreach ($entry in @(@{id=$saved.server;needle=$serverFile},@{id=$saved.tunnel;needle='cloudflared.exe'})) {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.id) -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine.Contains($entry.needle)) { Stop-Process -Id $entry.id }
}
Write-Output 'Smena test server and tunnel stopped.'
