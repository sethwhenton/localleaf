# LocalLeaf

LocalLeaf is a host-powered Overleaf-style collaboration app.

The host runs this app locally, opens a LaTeX project, starts a session, and shares an invite link. Guests join from a browser. The host machine owns the files, runs compilation, and ends the room when the host stops the session.

## Website and Download

- Landing page: https://sethwhenton.github.io/localleaf/
- Latest Windows installer: https://github.com/sethwhenton/localleaf/releases/latest/download/LocalLeaf-Host-Setup-0.1.0.exe

## Run

```powershell
node src/server/index.js
```

Then open:

```text
http://localhost:4317
```

On Windows you can also double-click:

```text
start-localleaf.cmd
```

## Test

```powershell
node --test tests/*.test.js
```

## Current Notes

- Live editing uses server-sent events plus debounced saves.
- LocalLeaf imports real `.zip` LaTeX projects and stores imported projects under the host user's Documents folder.
- The Windows installer bundles Tectonic for lightweight PDF compilation.
- LocalLeaf tries `latexmk`, bundled `tectonic.exe`, system `tectonic`, `pdflatex`, `xelatex`, and `lualatex` for PDF compilation.
- If no compiler is available, LocalLeaf shows compiler guidance and a readable HTML preview fallback.
- LocalLeaf races available tunnel providers and uses the first verified public URL for invite links.
- If `bin/cloudflared.exe` or a PATH `cloudflared` install is available, Cloudflare Quick Tunnel is included as one tunnel provider.

## Packaging

See [docs/packaging.md](docs/packaging.md).

## LaTeX Compiler

See [docs/latex-setup.md](docs/latex-setup.md).

## Cloudflared

See [docs/cloudflared-setup.md](docs/cloudflared-setup.md).
