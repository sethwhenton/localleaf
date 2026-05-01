# Cloudflared Setup

LocalLeaf can create public internet invite links through Cloudflare Quick Tunnel.

The app looks for `cloudflared` in this order:

1. `LOCALLEAF_CLOUDFLARED_PATH`
2. `bin/cloudflared.exe` inside this project or packaged app resources
3. `cloudflared` on PATH

## Install Into This Project

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cloudflared.ps1
```

This downloads the Windows amd64 binary from Cloudflare's official GitHub releases into:

```text
bin/cloudflared.exe
```

After installation, restart LocalLeaf and click `Host Online Session`. The invite link should switch from localhost to a `trycloudflare.com` URL once the tunnel connects.

## Security Note

A tunnel exposes the LocalLeaf host server to the public internet. Invite codes and host approval protect the room, but the host should only share links with people they trust.
