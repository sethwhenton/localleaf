$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "bin"
$target = Join-Path $bin "cloudflared.exe"
$url = "https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-windows-amd64.exe"
$expectedSha256 = "59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885"

New-Item -ItemType Directory -Force -Path $bin | Out-Null

Write-Host "Downloading cloudflared from Cloudflare's official GitHub releases..."
Invoke-WebRequest -Uri $url -OutFile $target
$actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "Checksum mismatch for cloudflared.exe. Expected $expectedSha256 but got $actualSha256."
}

Write-Host "Downloaded to $target"
& $target --version
