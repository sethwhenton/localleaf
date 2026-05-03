# LocalLeaf

LocalLeaf is a host-powered, Overleaf-style LaTeX collaboration app. The host runs the desktop app, opens a LaTeX project, starts a session, and shares an invite link. Guests join from a browser, edit together in real time, chat, compile, and download the project while the host machine remains the source of truth.

When the host stops the session or closes the app, the room ends.

## Website and Downloads

- Landing page: https://sethwhenton.github.io/localleaf/
- Latest Windows installer: https://github.com/sethwhenton/localleaf/releases/latest/download/LocalLeaf-Host-Setup.exe
- Latest macOS installer, Apple Silicon: https://github.com/sethwhenton/localleaf/releases/latest/download/LocalLeaf-Host-mac-arm64.dmg
- Latest macOS installer, Intel: https://github.com/sethwhenton/localleaf/releases/latest/download/LocalLeaf-Host-mac-x64.dmg

## Current Release

Version `0.1.13` is the code-editor-first final MVP build: cleaner Home and Session Management flows, a stronger starter project, improved file-tree actions, update checks, and release-ready Windows/macOS download links.

## Features

- Host-controlled desktop app for Windows and macOS.
- Browser-based guest access through public invite links.
- Smart tunnel racing across available providers, using the first verified public URL.
- Real `.zip` LaTeX project import with folders, images, bibliography files, and source files preserved.
- File tree with folder grouping, image grouping, rename, delete, upload, and set-main-file support.
- Real CodeMirror 6 LaTeX code editor with line numbers, command highlighting, toolbar actions, shortcuts, and autocomplete.
- Visual Editor is intentionally parked as coming soon while the code editor ships as the stable editing surface.
- One-click New Project flow with a compile-safe starter template covering common LaTeX commands, figures, tables, math, labels, references, citations, macros, and bibliography.
- File tree actions for new file, new folder, inline rename, double-click rename, copy/paste, drag into folders or back to root, download, delete, upload, and set-main-file support.
- Search and replace panel for editor work, with case, regex, and whole-word toggles.
- Keyboard shortcuts for save/recompile, bold, italic, undo, redo, comments, indentation, and autocomplete.
- Real-time shared text editing over WebSockets with file-level presence, without cursor or selection sync.
- Working project chat.
- Save, recompile, export ZIP, export PDF, and connected-guest ZIP download support with correct `.zip` and `.pdf` filenames.
- PDF compilation through bundled Tectonic, system LaTeX tools, or fallback preview guidance.
- PDF preview powered by PDF.js, with smooth zoom buttons, Ctrl+mouse-wheel zoom, and page/scroll preservation after recompiles.
- Compile logs with pinned red error groups, clearable orange warning groups, and gray informational output.
- Session management screen with invite copy feedback, user list, health status, and stop-session handling.
- Host-only update prompt and manual update checks when a newer LocalLeaf release is available.
- Guests are notified when the host ends the session.
- Hosts can stop a session and continue editing locally without being bounced back to the ended-session screen.

## How It Works

1. The host installs and opens LocalLeaf Host.
2. The host creates, opens, or imports a LaTeX project.
3. The host starts an online session.
4. LocalLeaf starts the local server, compiler, collaboration socket, and public tunnel.
5. Friends open the invite link in a browser.
6. Everyone edits the same host-owned project.
7. The host compiles and serves the latest PDF preview.
8. When the host stops the session, guests disconnect gracefully.

## Run Locally

Install dependencies:

```powershell
npm install
```

Run the server-only web app:

```powershell
npm start
```

Then open:

```text
http://localhost:4317
```

Run the desktop app in development:

```powershell
npm run dev:desktop
```

## Test

```powershell
npm test
```

The test suite builds the client bundles and runs the server, compiler, import, collaboration, tunnel, path-safety, and PDF-serving tests.

## Build Installers

Build the Windows installer:

```powershell
npm run package:win
```

Build macOS installers:

```powershell
npm run package:mac:x64
npm run package:mac:arm64
```

## Notes

- The host computer owns the project files and compile output.
- Guests do not need to install anything; they join from a browser.
- macOS builds are unsigned, so users may need to allow the app manually in macOS security settings.
- LocalLeaf tries `latexmk`, bundled Tectonic, system `tectonic`, `pdflatex`, `xelatex`, and `lualatex` for PDF compilation.
- If no compiler is available, LocalLeaf shows compiler guidance and a readable HTML preview fallback.
- Cloudflare Quick Tunnel is used when bundled or installed `cloudflared` is available.

## Docs

- Packaging: [docs/packaging.md](docs/packaging.md)
- LaTeX setup: [docs/latex-setup.md](docs/latex-setup.md)
- Cloudflared setup: [docs/cloudflared-setup.md](docs/cloudflared-setup.md)
