# Packaging LocalLeaf Host

The packaged desktop app uses Electron to open the LocalLeaf Host control center and starts the local server internally.

## Windows

Install packaging dependencies:

```powershell
npm.cmd install --save-dev electron electron-builder
```

Optional but recommended:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cloudflared.ps1
```

Required for a compiler-included installer:

```powershell
npm.cmd run install:tectonic
```

## Build Installer

```powershell
npm.cmd run package:win
```

The installer output is written to:

```text
release/
```

## macOS

macOS builds must run on macOS. Electron Builder's macOS signing/build path depends on Apple's tooling, so LocalLeaf uses GitHub Actions macOS runners for the downloadable DMGs.

The workflow is:

```text
.github/workflows/macos-release.yml
```

It builds two installers:

- `LocalLeaf-Host-mac-arm64.dmg` for Apple Silicon Macs
- `LocalLeaf-Host-mac-x64.dmg` for Intel Macs

The workflow downloads matching macOS builds of Tectonic and cloudflared, generates `build/icon.icns`, packages the app, and uploads the DMGs to the GitHub release.

The macOS build is ad-hoc signed for testing. A fully trusted one-click macOS install requires Apple Developer ID signing and notarization.

## What Gets Packaged

- LocalLeaf desktop shell
- Local web editor
- Host server
- Sample project
- Bundled Tectonic compiler if installed
- Bundled cloudflared tunnel binary if installed

The app can still run without `cloudflared`, but internet invite links will stay local-only. It can still run without Tectonic, but real PDF compilation will require a system TeX install.
