$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "bin"
$target = Join-Path $bin "tectonic.exe"
$licenseDir = Join-Path $bin "licenses"
$licenseTarget = Join-Path $licenseDir "TECTONIC_LICENSE.txt"
$apiUrl = "https://api.github.com/repos/tectonic-typesetting/tectonic/releases/latest"

New-Item -ItemType Directory -Force -Path $bin | Out-Null
New-Item -ItemType Directory -Force -Path $licenseDir | Out-Null

Write-Host "Finding latest Tectonic release from GitHub..."
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "LocalLeaf Installer" }
$asset = $release.assets |
  Where-Object { $_.name -match "x86_64-pc-windows-msvc\.zip$" } |
  Select-Object -First 1

if (-not $asset) {
  throw "Could not find a Windows x64 Tectonic release asset."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("localleaf-tectonic-" + [System.Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot $asset.name
$extractRoot = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

try {
  Write-Host "Downloading $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

  Write-Host "Extracting Tectonic..."
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $tectonic = Get-ChildItem -Path $extractRoot -Filter "tectonic.exe" -Recurse | Select-Object -First 1
  if (-not $tectonic) {
    throw "Downloaded archive did not contain tectonic.exe."
  }

  Copy-Item -LiteralPath $tectonic.FullName -Destination $target -Force

  $license = Get-ChildItem -Path $extractRoot -File -Recurse |
    Where-Object { $_.Name -match "^(LICENSE|COPYING)" } |
    Select-Object -First 1

  if ($license) {
    Copy-Item -LiteralPath $license.FullName -Destination $licenseTarget -Force
  } else {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/tectonic-typesetting/tectonic/master/LICENSE" -OutFile $licenseTarget
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Downloaded to $target"
& $target --version
