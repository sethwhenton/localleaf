$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "bin"
$target = Join-Path $bin "cloudflared.exe"
$url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host "Downloading cloudflared from Cloudflare's official GitHub releases..."
Invoke-WebRequest -Uri $url -OutFile $target

Write-Host "Downloaded to $target"
& $target --version
