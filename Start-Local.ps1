param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$CloudflaredPath)
$ErrorActionPreference = 'Stop'
$configFile = (Resolve-Path -LiteralPath $ConfigPath).Path
$tunnelExe = (Resolve-Path -LiteralPath $CloudflaredPath).Path
$runtimeDir = Split-Path -Parent $configFile
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
$pidFile = Join-Path $runtimeDir 'processes.json'
if (Test-Path -LiteralPath $pidFile) {
    $prior = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
    foreach ($entry in @(@{id=$prior.server;path=$serverFile},@{id=$prior.tunnel;path=$tunnelExe})) {
        if ($entry.id) {
            $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.id) -ErrorAction SilentlyContinue
            if ($process -and $process.CommandLine -and $process.CommandLine.Contains($entry.path)) {
                Stop-Process -Id $entry.id -ErrorAction SilentlyContinue
            }
        }
    }
}
$tag = Get-Date -Format 'yyyyMMdd-HHmmss'
$tunnelLog = Join-Path $runtimeDir ('tunnel-' + $tag + '.log')
$tunnelOut = Join-Path $runtimeDir ('tunnel-' + $tag + '.out.log')
$tunnelArgs = @('tunnel','--no-autoupdate','--url','http://127.0.0.1:8732','--protocol','http2')
$tunnel = Start-Process -FilePath $tunnelExe -ArgumentList $tunnelArgs -WorkingDirectory $runtimeDir -WindowStyle Hidden -RedirectStandardError $tunnelLog -RedirectStandardOutput $tunnelOut -PassThru
$publicUrl = $null
for ($attempt=0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $tunnelLog) {
        $match = [regex]::Match((Get-Content -Raw -LiteralPath $tunnelLog),'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($match.Success) { $publicUrl = $match.Value; break }
    }
    if ($tunnel.HasExited) { throw 'Cloudflare tunnel stopped. Check private runtime logs.' }
}
if (-not $publicUrl) { Stop-Process -Id $tunnel.Id; throw 'No HTTPS tunnel URL received.' }
$config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
$config | Add-Member -NotePropertyName publicUrl -NotePropertyValue $publicUrl -Force
$config | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $configFile
$node = (Get-Command node).Source
$serverLog = Join-Path $runtimeDir ('server-' + $tag + '.log')
$serverErr = Join-Path $runtimeDir ('server-' + $tag + '.err.log')
$previousConfig = $env:SMENA_CONFIG
try {
    $env:SMENA_CONFIG = $configFile
    $server = Start-Process -FilePath $node -ArgumentList @('"'+$serverFile+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -PassThru
} finally { $env:SMENA_CONFIG = $previousConfig }
@{server=$server.Id;tunnel=$tunnel.Id;publicUrl=$publicUrl} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $pidFile
for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8732/health' -TimeoutSec 1; if ($health.status -eq 'ok') { break } } catch { }
    if ($server.HasExited) { throw 'Smena server stopped. Check private runtime logs.' }
}
if (-not $health) { throw 'Server readiness timeout. Check private runtime logs.' }
[pscustomobject]@{status='running';url=$publicUrl;bot=('https://t.me/' + $config.botUsername);serverPid=$server.Id;tunnelPid=$tunnel.Id} | ConvertTo-Json
