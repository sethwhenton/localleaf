# LocalLeaf Project Context

Last updated: May 3, 2026

## What LocalLeaf Is

LocalLeaf is a self-hosted Overleaf-style LaTeX collaboration app for students.

The host installs and runs a desktop app on their own computer. The app starts a local Node/Electron host, opens a browser-based editor, compiles LaTeX locally, and shares a temporary public invite link through a tunnel. Friends join from their browser using that invite link. When the host stops the session or closes the app, collaboration stops.

Core principle: the host machine is the source of truth. Project files stay on the host computer unless the host exports/shares them.

## Repository And Release State

- Repository: `https://github.com/sethwhenton/localleaf.git`
- Landing page: `https://sethwhenton.github.io/localleaf/`
- Workspace path: `E:\Programming\Overleaf clone`
- Current package version at the time of this handoff: `0.1.12`
- Last pushed release before this handoff update: `v0.1.11`
- Last verified Windows installer before this handoff update: `release\LocalLeaf Host Setup 0.1.11.exe`
- GitHub release assets for `v0.1.11` were verified:
  - `LocalLeaf-Host-Setup.exe`
  - `LocalLeaf-Host-mac-arm64.dmg`
  - `LocalLeaf-Host-mac-x64.dmg`
- GitHub Actions passed for:
  - Windows release build
  - macOS release build
  - Landing page deploy

## Architecture

- Desktop shell: `src/desktop/main.js`
- Local server/API/WebSocket host: `src/server/index.js`
- Browser app UI: `public/app.js`
- Main styling: `public/styles.css`
- Code editor bundle source: `src/client/editor.js`
- PDF preview bundle source: `src/client/pdf-preview.js`
- Server-side LaTeX compile flow: `src/server/compiler.js`
- Safe file/project path helpers: `src/server/safe-path.js`
- Editor suggestion extraction: `src/server/editor-suggestions.js`
- Tests: `tests/*.test.js`
- Landing page: `landing-page/`
- Packaged app output: `release/`

The app uses Electron for the installed host app, Node for the local server, CodeMirror 6 for the code editor, PDF.js for the custom preview, WebSockets for realtime collaboration, and bundled/local LaTeX tooling support with Tectonic/MiKTeX detection.

## Major Features Already Built

- Host desktop app with a white/orange LocalLeaf design.
- Home screen, project overview, and session management screens.
- Project creation, project opening, and ZIP import.
- Real project file tree with folders and grouped images.
- Editor opens only after a project exists.
- Browser-based editor similar to Overleaf.
- Code editor powered by CodeMirror 6.
- Visual editor mode for simpler text/headings and selected LaTeX structures.
- Code/visual editor toggle in the editor toolbar.
- Editor tabs removed; file switching is done through the left file tree.
- Adjustable/hideable file sidebar, editor pane, PDF pane, chat/user rail, and logs panel.
- Separate scrolling for file tree, editor, preview, chat, and logs.
- Save, recompile, export, set main file, and download ZIP controls.
- `Ctrl+S` saves and recompiles.
- `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+Z` undo, `Ctrl+Y` redo.
- PDF preview keeps scroll/zoom position across recompiles.
- Smooth PDF zoom, including `Ctrl + mouse wheel` over the preview.
- Real LaTeX compilation using the host machine compiler flow.
- Custom PDF viewer instead of relying only on browser PDF iframe behavior.
- ZIP export and PDF export endpoints.
- Chat with real messages.
- Join requests pop up for the host, including while already inside the editor.
- Realtime collaboration over WebSockets:
  - Shared text updates across clients.
  - File-open presence updates.
  - No cursor/selection/viewport sharing.
  - Host remains single source of truth.
  - Clients reconnect/resync after WebSocket/tunnel disruption.
- Session-ended screen for guests when host stops the session.
- Guests can download the project ZIP while the host app/link are still reachable.
- Cloudflare Tunnel support.
- Localtunnel support.
- Tunnel reliability work so the app can race supported tunnel providers and use the first good public link.
- Clipboard copy fallback/feedback for invite links.
- Landing page with LocalLeaf branding, download buttons, responsive layout, and scroll animations.
- Windows packaging with bundled resources.
- macOS unsigned DMG/ZIP build support for Intel and Apple Silicon.

## Editor v1.1 Work Completed

- Replaced the old textarea editor with CodeMirror 6.
- Added bundled offline editor assets through `public/editor.bundle.js`.
- Added LaTeX command highlighting with orange command/backslash styling.
- Added command autocomplete triggered by `\` and `Ctrl/Cmd+Space`.
- Added project-aware suggestions for labels, citations, macros, and custom environments.
- Added `GET /api/editor/suggestions`.
- Added toolbar controls for common LaTeX editing actions.
- Added editor search/replace popover.
- Added visual table insert picker.
- Added hover highlight for table-size selection.
- Improved visual editor so table/figure-like blocks blend visual editing with LaTeX structure.
- Added visual-editor line numbers.
- Fixed visual editor changes so they save and compile instead of producing blank PDFs.
- Fixed session-ended bounce where returning to editor could reopen the ended screen.
- Added Overleaf-style figure source editing in visual mode:
  - Figure blocks show a source-like visual layout by default.
  - The edit figure source button opens an embedded CodeMirror LaTeX editor.
  - The embedded source editor supports command highlighting and autocomplete.
  - Leaving a valid figure source block returns it to the visual figure UI.
  - Tab inserts indentation while editing visual/source fields.

## Compile Log Work Completed

The compile log area was redesigned so output is easier to read:

- Errors are classified and shown in red.
- Warnings are classified and shown in orange.
- Neutral compile output remains gray.
- Errors and warnings are grouped.
- Current compile errors remain pinned until fixed.
- Warnings can be cleared by the user.
- Compile status summary is shown near the log actions.

## Packaging And Build Commands

Common commands:

```powershell
npm run build:client
npm test
npm run package:win
npm run package:mac:x64
npm run package:mac:arm64
```

Quick syntax checks often used before packaging:

```powershell
node --check public\app.js
node --check src\server\index.js
node --check src\client\pdf-preview.js
git diff --check
```

Windows package output is created in `release/`.

## GitHub Release Flow Used So Far

The established release pattern has been:

1. Implement and test locally.
2. Bump `package.json` and `package-lock.json`.
3. Update README and landing page version/download copy when needed.
4. Run tests and local Windows packaging.
5. Commit changes.
6. Tag as `vX.Y.Z`.
7. Push `main` and tag.
8. Wait for GitHub Actions to finish.
9. Verify release assets exist on GitHub.

## Important Product Decisions

- LocalLeaf is not a cloud-hosted Overleaf clone.
- The host installs the app; guests only need a browser.
- Guest collaborators should not need accounts.
- The host controls the session and the files.
- Collaboration should be cheap/free and work over temporary public links.
- Public tunnel providers can be unreliable, so multiple tunnel options are useful.
- Code editor is the reliable source editor.
- Visual editor should be helpful but must not corrupt LaTeX.
- No cursor sync for v1.x collaboration.
- No selection sync for v1.x collaboration.
- No viewport sync for v1.x collaboration.

## Known Caveats

- macOS builds are unsigned. Without Apple Developer Program signing and notarization, macOS Gatekeeper can show warnings. This was explained to the user.
- Public tunnels can break or get rate-limited. Cloudflare quick tunnels can return errors like `530 The origin has been unregistered from Argo Tunnel` if the tunnel dies or the wrong/old link is shared.
- Guests can only download project ZIP/PDF while the host app and public route are still reachable.
- Visual editor support is intentionally conservative. Complex LaTeX is preserved in source-style blocks.

## Latest Completed Requests

After this context file was first created, the update/export request was implemented:

1. Added a host-only update notification card.
   - The host app checks `/api/update/latest`.
   - The server checks the latest GitHub release for `sethwhenton/localleaf`.
   - The card appears near the top-right under the app titlebar.
   - It is dismissible per latest version with `localStorage`.
   - It links to the best matching release asset for the current platform, falling back to the latest GitHub release page.
   - Guests do not see this update card.

2. Fixed export download file names and content types.
   - Source ZIP links now use explicit `download="Project.zip"` names.
   - Guest session-ended ZIP downloads also use explicit `.zip` names.
   - Export PDF now saves/recompiles first, then starts a `.pdf` download.
   - Server attachment headers now include both `filename` and `filename*`.
   - PDF export returns `application/pdf` with attachment disposition.
   - ZIP export returns `application/zip` with attachment disposition.

Validation run after this work:

```powershell
node --check public\app.js
node --check src\server\index.js
npm test
git diff --check
```

All tests passed.

The next visual-editor request was also implemented:

- Embedded CodeMirror in the edit-figure-source block.
- Disabled visual line-break insertion in embedded raw source editors so Enter behaves like a normal code editor.
- Preserved command autocomplete and LaTeX coloring in embedded figure source.
- On blur, valid figure/table source is parsed back into the visual block.
- Restored the Overleaf-style dark circular edit button on figure blocks.
- Rebuilt client bundles and ran `npm test`.

## Files Likely Needed For The Pending Request

- `public/app.js`
  - Export modal lives around `showExportModal()`.
  - Header ZIP button uses `downloadZipButton`.
  - Session-ended ZIP download link also needs a real `.zip` filename.
  - Add update-toast state, markup, render/bind logic, and one-time update check.

- `public/styles.css`
  - Add top-right update card/toast styles.

- `src/server/index.js`
  - Export routes:
    - `/api/export/pdf`
    - `/api/export/zip`
  - Existing helpers:
    - `safeDownloadName(name, extension)`
    - `attachmentHeaders(filename, contentType)`
  - Add stronger `filename` and `filename*` content disposition.
  - Add host-only update-check API, likely `/api/update/latest`, backed by GitHub latest release metadata.

- `package.json` / `package-lock.json`
  - Bump patch version if releasing the change.

- `README.md` and `landing-page/`
  - Update release notes/version copy if publishing a new release.

## User Preferences And UI Direction

- Keep the app white/orange and visually consistent.
- Avoid black bars and cramped app-window mockup styling.
- Make screens feel like a real app, not a tiny centered card.
- Keep UI simple and not overcomplicated.
- Prefer clear icons like Word/Overleaf-style toolbar icons.
- Use the actual LocalLeaf logo, not Electron defaults.
- Guests should have a polished browser join/editing experience.
- Host should get convenient popups for join requests and important session events.
- Editor should feel Overleaf-like, but LocalLeaf-branded.
