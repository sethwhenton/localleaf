# Packaging LocalLeaf Host

The packaged Windows app uses Electron to open the LocalLeaf Host control center and starts the local server internally.

## One-Time Setup

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

The installer output will be written to:

```text
release/
```

## What Gets Packaged

- LocalLeaf desktop shell
- Local web editor
- Host server
- Sample project
- Bundled `bin/tectonic.exe` compiler if installed
- Bundled `bin/cloudflared.exe` if installed

The app can still run without `cloudflared`, but internet invite links will stay local-only. It can still run without Tectonic, but real PDF compilation will require a system TeX install.
