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
- Last pushed release before this handoff update: `v0.1.12`
- Last verified Windows installer before this handoff update: `release\LocalLeaf Host Setup 0.1.12.exe`
- GitHub release assets for `v0.1.12` were verified:
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
- One-click project creation from a bundled starter template, project opening, and ZIP import.
- Real project file tree with folders and grouped images.
- Editor opens only after a project exists.
- Browser-based editor similar to Overleaf.
- Code editor powered by CodeMirror 6.
- Visual editor prototype for simpler text/headings and selected LaTeX structures, currently parked behind a disabled "Visual Editor soon" pill for shipping.
- Code editor remains the active editor surface.
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

The following visual editor math pass was implemented after that:

- Added a Visual Editor formula tool to the main editor toolbar.
- Inline formulas can be inserted while typing and serialize back to `\(...\)`.
- Typed `\(...\)`, `$...$`, and `\[...\]` patterns convert into editable visual math elements.
- Display math serializes back on separate LaTeX lines so it does not glue to paragraph text.
- Visual Editor now has a lightweight `\` command autocomplete popup with math commands plus project labels, citations, and macros.
- Choosing math commands outside math inserts a real math chip; choosing them inside math inserts the command text.
- Existing display math blocks like `\[...\]`, `equation`, and `align` parse into editable visual math blocks.
- Browser smoke test covered formula insertion, typed display math conversion, `\al` autocomplete, save serialization, and compile success on a temporary project.
- Rebuilt Windows locally and reopened `release\win-unpacked\LocalLeaf Host.exe`.

The next Visual Editor paste-consistency pass was implemented:

- Added Visual Editor copy normalization so selected formulas copy as real LaTeX, for example `\(\frac{a}{b}\)`.
- Added paste normalization so inline formulas, display math, figure blocks, table blocks, headings, and raw LaTeX snippets rebuild into the same visual objects instead of being dumped as mismatched text.
- Bare math command pastes such as `\frac{a}{b}` now become inline math chips with orange LaTeX highlighting.
- Display math pastes such as `\[...\]` now become display math blocks, not inline chips.
- Figure source pastes now become Overleaf-style figure visual blocks and save back as `\begin{figure}...\end{figure}`.
- Browser smoke test verified inline math paste/copy, display math paste, figure paste, and saved LaTeX serialization.
- Ran `node --check public\app.js`, `npm test`, rebuilt the Windows package, refreshed `release\LocalLeaf-Host-Setup.exe`, and reopened `release\win-unpacked\LocalLeaf Host.exe`.

The next Visual Editor source-block exit pass was implemented:

- Expanded figure source blocks now collapse back to normal Visual Editor blocks when their source is empty, plain text, display math, figure, table, heading, or otherwise parseable by the visual parser.
- Empty source becomes a blank numbered paragraph row and receives focus after clicking outside.
- Plain text source becomes a normal paragraph.
- Valid display math source becomes a math block.
- Invalid/partial complex LaTeX, such as an unclosed `\begin{figure}`, stays in source mode so the user does not lose work.
- Save/recompile now flushes empty or parseable expanded source blocks before writing the file.
- Browser smoke test covered empty blur, plain text blur, display math blur, invalid partial source preservation, and empty source save persistence.

The Visual Editor was then parked for shipping:

- The editor now always opens in Code Editor mode, even if old browser storage says `localleaf.editorMode=visual`.
- The editor surface always mounts the CodeMirror code editor for editable files.
- The toolbar keeps a disabled "Visual Editor soon" pill so the direction is visible without exposing the unstable visual editor.
- Code editor smoke testing confirmed stale Visual Editor preference cannot reopen visual mode, CodeMirror mounts correctly, line numbers render, `\` autocomplete opens, toolbar insertions work, and compile succeeds.
- Research check matched the code-editor MVP against CodeMirror 6 official docs and Overleaf's editor expectations: line numbers, LaTeX syntax highlighting, command autocomplete, keyboard shortcuts, search/replace, source ZIP/PDF export, compile logs, PDF preview, and collaboration remain the shipping path.

The Home and starter template rework was then implemented:

- Home now focuses on New Project, Import ZIP Project, Open Current Project, and Host Online Session.
- The manual Open Project button and Open Another Project link were removed from Home.
- If a session is already live, Home changes the session action to Manage Current Session.
- Added host-only `POST /api/project/new`.
- New Project creates a unique `LocalLeaf Project`, `LocalLeaf Project 2`, etc. under the user's LocalLeaf projects directory and opens it immediately.
- App startup now uses the new `LocalLeaf Project` starter path instead of the old `Thesis Draft` folder, so stale or manually edited old sample files are not treated as the base default.
- The bundled starter template in `samples/thesis` is now a compact compile-safe LaTeX tour with examples of document setup, sections, formatting, lists, links, footnotes, labels/refs, citations, math, figures, tables, macros, and bibliography.
- The starter includes a local PNG asset at `samples/thesis/assets/localleaf-icon.png` so `\includegraphics` works offline.
- Session Management no longer has a top-right Open Editor button; the editor CTA is now a long full-width button below the session cards.
- The known harmless Tectonic/Windows `Fontconfig error: Cannot load default config file` line is filtered out of live and final compile logs so it is not shown as a scary compile error.
- Validation covered `node --check`, `npm test`, `git diff --check`, a real bundled-Tectonic starter compile, Windows packaging, reopening the fresh Windows build, and compiling the running app's default starter project successfully.

The file tree toolbar was then tightened:

- Search/replace can now be closed with Escape from the search inputs or globally while the editor is focused.
- The file toolbar uses compact icon buttons with hover labels for New File, New Folder, Upload, Rename, and Delete.
- Folder rows are selectable, so Rename/Delete can target either the selected folder or selected file.
- New File, New Folder, and Upload default to the selected folder context, or the selected file's parent folder.
- `/api/file/rename` now supports both files and folders, including moving a file into a folder.
- Files and folders can be dragged in the tree and dropped onto folders to move them.
- Folder delete is supported while preventing deletion of the last editable text file.
- Validation covered `node --check`, `npm test`, Windows packaging, and reopening the fresh Windows build.

The inline file-tree create/rename pass was then implemented:

- Rename no longer opens a prompt. The selected file or folder row turns into an inline highlighted input with the current name selected.
- New File creates a unique `new file.tex`, `new file 2.tex`, etc. in the current tree context and immediately selects the new row name for inline renaming.
- New Folder creates a unique `new folder`, `new folder 2`, etc. in the current tree context and immediately selects the new folder name for inline renaming.
- Inline rename rejects empty names, path separators, and duplicate file/folder names in the same directory before calling the server.
- Server-side duplicate checks still protect create/rename/delete operations.
- API smoke testing covered new file creation, new folder creation, duplicate rejection, rename-to-existing rejection, file delete, and folder delete.

The inline rename UX was then refined:

- File renaming now edits only the filename stem while showing the extension, such as `.tex`, `.bib`, or `.png`, as a protected suffix.
- Pasting a full name like `paper.tex` into the stem field is normalized back to `paper` plus the protected `.tex` suffix.
- Double-clicking a file or folder row starts inline rename.
- Pressing Enter commits the inline name, while Escape cancels it.
- The file tree now has subtle vertical guide lines and elbows for nested folders/files so the structure is easier to read.

The file-tree context menu and drag/drop pass was then implemented:

- Right-clicking a file, folder, or the tree background opens a custom LocalLeaf context menu.
- Menu actions include Rename, Copy, Paste, Download, Set as main document, Delete, New file, New folder, and Upload, with invalid actions disabled.
- Copy/Paste duplicates files or folders inside the project using unique `copy` names and server-side collision checks.
- Added `POST /api/file/copy` for project item duplication.
- Added `GET /api/file/download?path=...` for raw file downloads and folder ZIP downloads.
- Dragging items onto folders still moves them into that folder; dragging a nested item onto the tree background moves it back to project root.
- Drag targets now show clearer feedback: the root tree gets an orange root drop outline, and folder rows get an orange circular target on the caret.
- Tests now cover file/folder copy, duplicate copy rejection, raw file download, and folder ZIP download.

The editor toolbar and outline polish pass was then implemented:

- Fixed a toolbar regression where New File/New Folder/Upload could receive a click `PointerEvent` as the target path, creating a bad `[object PointerEvent]` folder.
- Removed the bad generated `[object PointerEvent]` folder from the user's LocalLeaf projects directory.
- The text-style control is now a custom dark dropdown styled like Overleaf's hierarchy menu, with larger Section/Subsection/Subsubsection/Paragraph/Subparagraph options.
- The file outline now parses `chapter`, `section`, `subsection`, `subsubsection`, `paragraph`, and `subparagraph`.
- File outline rendering is now a nested tree-style list with guide lines, active highlight, and bounded scroll for long documents.

The update-check flow was then refined:

- LocalLeaf still checks for updates automatically when the app opens.
- Startup update checks are silent; if there is no internet connection or GitHub cannot be reached, no popup or error is shown.
- Added a Home `Check for updates` button.
- Added a compact editor top-bar `Update` button.
- Manual checks can run even after the startup check has already happened.
- Manual checks show the existing update toast if a release is available, and briefly show `Up to date` on the button when the app is current.

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
