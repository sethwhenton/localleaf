# Self-Hosted Overleaf-Style Desktop App Project Plan

Date researched: 2026-04-30

## 1. Product Vision

Build a cheap, student-friendly Overleaf alternative where one person hosts a live LaTeX collaboration session from their own Windows PC. Friends join with invite codes, edit together, compile LaTeX, preview the PDF, chat, and leave comments. When the host closes the app or turns off their PC, the session stops.

This should feel like Overleaf in daily use, but the infrastructure model is completely different:

- No permanent cloud server.
- No account system for the MVP.
- No always-on hosting bill.
- The host PC is the temporary server.
- Project files live on the host machine.
- Invite codes are the only way into a session.

Possible product names:

- LocalLeaf
- DeskLeaf
- PeerLeaf
- StudyLeaf
- LeafRoom
- PaperRoom
- SessionTeX

My favorite working name: **LocalLeaf**, because it explains the idea immediately.

## 2. What We Are Actually Building

The app is a desktop application that uses web technology for the interface, similar in spirit to apps that ship a web UI inside a desktop shell.

The host opens a project, clicks "Host Session", and gets an invite code. Other students install the same app, choose "Join Session", enter the invite code, and connect to the host.

Core workflow:

1. Host creates or opens a LaTeX project.
2. Host starts a session.
3. App creates a temporary local collaboration server on the host PC.
4. Host sends invite code to friends.
5. Friends join while the host app is running.
6. Everyone edits the same `.tex`, `.bib`, image, and support files.
7. Host machine runs LaTeX compilation.
8. Everyone sees the compiled PDF preview and logs.
9. Host closes session or PC turns off.
10. Session ends. The saved project remains on the host machine.

## 3. Research Takeaways

Overleaf's visible value is not just "LaTeX in browser". It is the combination of project sharing, simultaneous editing, comments, chat, project history, templates, and automatic PDF compilation. Overleaf lists simultaneous editing, commenting, chat, project sharing, visual/code editors, templates, and history/versioning as major features.

Overleaf already has self-hosted Community Edition and Server Pro products, but those are Docker/on-prem server deployments. They are useful reference material, but they do not match this product because our app should be temporary, host-owned, invite-code based, and cheap for students. Overleaf also warns that non-sandboxed LaTeX compiles are risky because LaTeX can access filesystem, network, and environment resources. We need to take compilation safety seriously even if the first version assumes trusted classmates.

Electron is the fastest practical desktop shell for an MVP because it gives us Chromium, Node.js, local filesystem access, child processes for LaTeX compilation, WebSocket servers, and packaging tools. Tauri is attractive because it makes smaller, secure cross-platform apps with a web frontend, but its Rust backend makes the first collaboration/compile prototype more work.

Yjs is the best fit for collaborative editing. It is a CRDT library designed for applications like Google Docs and Figma, and it can sync through different providers. Its y-websocket model maps well to our "host PC is server" design. y-webrtc is useful for demos and direct client links, but a real app still needs signaling and has NAT limitations.

WebRTC data channels are encrypted and peer-to-peer, but WebRTC still needs signaling, ICE, STUN, and sometimes TURN. With a strict no-cloud rule, remote internet joining cannot be guaranteed for every network. Same-Wi-Fi/LAN is straightforward. Across the internet, we need port forwarding, UPnP/NAT-PMP, direct public address, or user-provided VPN/tunnel tools.

For LaTeX compilation, `latexmk` is the standard automation layer because it knows when to rerun LaTeX, BibTeX/Biber, indexes, etc. MiKTeX is Windows-friendly and can install missing packages on demand. TeX Live is comprehensive but large. Tectonic is promising for a lighter "download missing support files" experience, but compatibility with complex Overleaf projects must be tested.

PDF.js is the obvious PDF preview layer because it parses and renders PDFs in a web UI.

## 4. Recommended MVP Stack

Use this stack first:

- Desktop shell: Electron
- UI: React + Vite + TypeScript
- Editor: CodeMirror 6
- Collaboration data model: Yjs
- Collaboration transport: host-run WebSocket server, probably y-websocket or a small custom provider
- Server runtime: Node.js inside Electron main process, or a spawned local Node service
- PDF preview: PDF.js
- LaTeX build tool: latexmk
- TeX distribution support: detect MiKTeX or TeX Live first; test Tectonic as optional lighter mode
- Local database: SQLite for project/session metadata, invite logs, settings, recent projects
- File storage: normal project folder on host disk
- Packaging: electron-builder
- Tests: Vitest for units, Playwright for app flows, multi-client integration tests

Why Electron first:

- It is easier to run a local WebSocket server.
- It is easier to spawn `latexmk`, `tectonic`, `bibtex`, `biber`, etc.
- It is easier to use Node libraries for networking, archives, file watching, and packaging.
- It gives a consistent Chromium target for CodeMirror and PDF.js.

Why not Tauri first:

- Tauri is better for app size and security, but the Rust backend will slow down the first prototype.
- We can revisit Tauri after proving the editing, syncing, compiling, and invite model.

## 5. Product Surface

The UI should copy the useful Overleaf skeleton without copying branding:

- Project dashboard
- Main editor screen
- Left file tree
- Center code editor with tabs
- Right PDF preview
- Top toolbar with compile, share, logs, settings, and project name
- Bottom or side compile log panel
- Collaborator presence list
- Colored remote cursors
- Chat panel
- Comments/review panel
- Invite/session panel

MVP editor screen layout:

```text
+----------------------------------------------------------------+
| Project name      Compile   Share Session   Users   Settings   |
+-------------------+----------------------------+---------------+
| File tree         | Code editor                | PDF preview   |
|                   |                            |               |
| main.tex          | \documentclass{article}    | rendered PDF  |
| references.bib    | ...                        |               |
| images/           |                            |               |
|                   |                            |               |
+-------------------+----------------------------+---------------+
| Compile logs / warnings / errors                               |
+----------------------------------------------------------------+
```

## 6. Feature Parity Plan

We should not promise full Overleaf parity in v1. We should build the core loop first, then climb toward parity.

MVP features:

- Create/open/import project folder
- Edit `.tex`, `.bib`, `.cls`, `.sty`, `.md`, plain text files
- Upload/add images and PDFs to project
- File tree create/rename/delete/move
- Multi-user live editing for text files
- Remote cursors and user colors
- Host-only compile using `latexmk`
- PDF preview refresh for all users
- Compile logs and error navigation
- Invite code join
- Host can kick users
- Host shutdown ends session
- Basic chat
- Autosave on host disk

Version 1.1:

- Project zip import/export
- Better BibTeX/Biber support
- SyncTeX forward/inverse search
- Comments attached to text ranges
- Project snapshots
- Read-only invite codes
- Review-only invite codes
- Basic templates
- Recent projects

Version 1.2:

- TexLab language server for completions, diagnostics, symbols, references
- Spell check
- Symbol palette
- Snippets
- Image preview
- Table helper
- Conflict-safe binary file sync
- Reconnect/resync after temporary network drop

Version 2:

- Track changes/review mode
- Full history browser
- Host migration or "make another user host"
- Optional internet joining through UPnP/manual port forwarding
- Optional WebRTC/libp2p experiments
- Optional visual/rich editor mode
- Optional local-only AI assistant, if wanted later

## 7. Collaboration Architecture

Use a host-authoritative local session.

Host responsibilities:

- Owns the project files.
- Runs the WebSocket collaboration server.
- Persists text updates to disk.
- Receives binary file uploads.
- Runs LaTeX compilation.
- Broadcasts PDF output and compile logs.
- Controls session permissions.
- Ends the session.

Client responsibilities:

- Connects with an invite code.
- Keeps a local in-memory Yjs document.
- Sends edits to host.
- Receives edits from host and other clients.
- Requests compile or sees host-triggered compile.
- Displays PDF and logs.

Recommended Yjs model:

- One Yjs document per text file, or one project-level Yjs document containing file maps.
- `Y.Text` for editable text files.
- `Y.Map` for project metadata and file tree.
- Awareness protocol for user name, color, active file, cursor, and selection.
- Binary files synced separately using hash/chunk protocol, not CRDT text.

Persistence:

- Host writes text files to disk after debounced updates.
- Host stores Yjs update logs or SQLite snapshots so crashes can recover recent edits.
- Clients can cache temporary state, but host is the source of truth for v1.

## 8. Invite Code Design

Invite codes should be short enough to send in Discord/WhatsApp but powerful enough to connect safely.

The invite code can encode:

- App protocol version
- Session ID
- Host display name
- Host LAN IP address and port
- Optional public address and port
- Session public key fingerprint
- Join token
- Permission mode: edit, review, read-only
- Expiration timestamp

Example human format:

```text
LOCALLEAF-7XQ9-K2PD-MAIN
```

Better sharing format:

```text
localleaf://join?code=...
```

UX:

- Host clicks "Host Session".
- App shows copyable code and QR code.
- Guest enters code or opens `localleaf://join?...`.
- Host sees "Maya wants to join" and accepts/denies.
- Guest appears in collaborator list.

Security rules:

- Invite codes expire.
- Host can revoke all codes.
- Host can create separate read-only/review/edit codes.
- Host can kick a user.
- Host can lock the project.
- Joining requires explicit host approval in early versions.

## 9. Networking Plan

Phase 1: Same computer simulation

- Run two app windows connected to localhost.
- Prove Yjs, file sync, compile, PDF broadcast.

Phase 2: Same LAN/Wi-Fi

- Host listens on local network.
- Invite code includes host LAN IP and port.
- Windows Firewall prompt will appear; we need clear UX.
- Optional mDNS discovery can make join easier, but invite code should still work.

Phase 3: Internet direct mode

- Try UPnP/NAT-PMP to open a port automatically.
- Fallback to manual port forwarding instructions.
- Invite code includes detected public IP/port if available.

Phase 4: Advanced connectivity experiments

- WebRTC data channels.
- libp2p with TCP/QUIC/WebRTC transports.
- Hole punching where possible.
- Optional user-provided relay only if the "no cloud" rule is relaxed.

Important truth:

No-cloud global internet joining cannot be guaranteed on all networks. NAT, carrier-grade NAT, school networks, and firewalls can block inbound connections. For a reliable no-cloud v1, we should market it as "works best on the same Wi-Fi/LAN". For remote friends, support port forwarding, UPnP, or VPN tools like Tailscale/ZeroTier as optional user-managed paths.

## 10. LaTeX Compilation Plan

Host-only compilation is the right model. It avoids every client needing LaTeX installed.

Compile flow:

1. User clicks Compile.
2. Host saves pending text changes.
3. Host copies project into a temporary build directory.
4. Host runs `latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1 main.tex`.
5. Host captures stdout/stderr and log files.
6. Host sends compile status to clients.
7. Host sends generated PDF bytes/version to clients.
8. Clients refresh PDF.js preview.

Compiler choices:

- MiKTeX: best default for Windows students because it is modern, cross-platform, and can install missing packages on demand.
- TeX Live: best compatibility for serious projects, but large.
- Tectonic: promising lightweight option; good for simple projects, but must be tested against common Overleaf templates.

MVP approach:

- Detect existing `latexmk`, `pdflatex`, `xelatex`, `lualatex`, `bibtex`, `biber`.
- If missing, guide user to install MiKTeX or TeX Live.
- Store compiler path in settings.
- Add Tectonic as an experimental compile engine.

Security:

- Disable shell escape by default.
- Run compiles in an isolated temp directory.
- Only copy project files into build directory.
- Set timeouts and memory/process limits where possible.
- Strip dangerous environment variables.
- Block path traversal in uploaded files.
- Warn that LaTeX projects from untrusted users can be dangerous.

Later sandbox options:

- Windows Job Objects and restricted process tokens.
- Containerized compile mode for users who have Docker.
- WSL/Docker compile backend for stronger isolation.
- Dedicated compile worker process with narrow permissions.

## 11. Project File Model

A project is just a folder on the host machine:

```text
My Thesis/
  main.tex
  chapters/
    introduction.tex
  figures/
    architecture.png
  references.bib
  localleaf.json
```

`localleaf.json` stores:

- Project ID
- Main TeX file
- Compiler recipe
- Ignored files
- Last opened file
- Optional template metadata

Do not hide files in a proprietary format. Students should be able to open the folder in VS Code, TeXstudio, or another editor.

## 12. App Modules

Suggested code modules:

```text
apps/desktop/
  src/main/             Electron main process
  src/preload/          Safe bridge APIs
  src/renderer/         React app

packages/collab/
  yjs project model
  awareness helpers
  text file binding

packages/session-server/
  WebSocket server
  auth/invite validation
  project sync
  binary file sync

packages/compiler/
  latexmk runner
  tectonic runner
  log parser
  PDF artifact manager

packages/project-fs/
  safe filesystem operations
  import/export zip
  file watcher

packages/ui/
  reusable components
  editor shell
  file tree
  toolbar
```

## 13. Data And Sync Details

Text files:

- Load file text into `Y.Text`.
- Bind CodeMirror to `Y.Text`.
- Broadcast updates over WebSocket.
- Debounced save to host filesystem.
- Snapshot occasionally for crash recovery.

Binary files:

- Use content hashes.
- Send file metadata first.
- Upload/download chunks.
- Reject files above configured size.
- Do not CRDT-sync binary content.

File tree:

- Store file metadata in `Y.Map`.
- Host validates actual filesystem operations.
- Clients request create/rename/delete.
- Host performs operation and broadcasts result.

Compile artifacts:

- Keep generated files in build directory.
- Do not sync generated clutter as project files.
- Sync only current PDF, log summary, and diagnostics.

## 14. Comments And Review

MVP comments can be simple:

- Comment belongs to file path plus text range.
- Store comment ID, author, timestamp, range, status.
- If text changes, use Yjs relative positions so comments move with text when possible.
- Thread replies.
- Resolve/unresolve.

Track changes is harder:

- Needs insert/delete attribution.
- Needs accept/reject operations.
- Needs visual diff mode.
- Should be post-MVP.

## 15. History And Backups

Because there is no cloud, the host needs strong local backup behavior.

MVP:

- Autosave every few seconds.
- Project snapshots on compile.
- Manual "Create Snapshot".
- Export zip.

Later:

- Full timeline.
- Named versions.
- Diff between snapshots.
- Restore file/project from snapshot.
- Optional Git integration.

## 16. Security Model

Assume invited users are classmates, but still design safely.

Threats:

- Malicious LaTeX file tries to read host files.
- Uploaded file path tries to escape project directory.
- User floods host with edits or huge files.
- Invite code leaks.
- Client sends invalid project operations.
- Host runs project from unknown source.

Controls:

- Host validates every filesystem path.
- Project root sandbox prevents `../` writes.
- File size limits.
- Compile timeout.
- Disable shell escape.
- Invite expiry and revocation.
- Host approval before join.
- Per-session random tokens.
- App-level permission checks.
- No automatic execution except LaTeX compile.
- Clear warning for untrusted projects.

## 17. Milestones

Milestone 0: Technical spike, 3 to 5 days

- Electron + React + CodeMirror shell.
- Open a local `.tex` project.
- Run `latexmk`.
- Display PDF.js preview.
- Confirm Windows paths and process handling.

Milestone 1: Single-user Overleaf-like editor, 1 to 2 weeks

- File tree.
- Editor tabs.
- Compile button.
- Logs panel.
- PDF preview.
- Recent projects.
- Settings for compiler path.

Milestone 2: Local collaboration prototype, 1 to 2 weeks

- Host session server.
- Join from second app window.
- Yjs text sync.
- Awareness cursors.
- Basic invite token.
- Host session shutdown.

Milestone 3: Real LAN session, 1 to 2 weeks

- Join from another PC on same Wi-Fi.
- Windows firewall guidance.
- File tree sync.
- Binary image upload.
- PDF broadcast.
- Reconnect handling.

Milestone 4: Student MVP, 2 to 3 weeks

- Chat.
- Comments.
- Project zip import/export.
- Host accept/deny/kick.
- Read-only/edit invite modes.
- Project snapshots.
- Better compile diagnostics.

Milestone 5: Packaging and hardening, 1 to 2 weeks

- Installer.
- Auto-update plan or manual update download.
- Crash recovery.
- Compile sandbox improvements.
- Playwright multi-client tests.
- Usability pass.

Milestone 6: Remote internet mode, research and prototype

- UPnP/NAT-PMP.
- Manual port forwarding.
- WebRTC/libp2p experiments.
- Decide whether optional relay/VPN integration is allowed.

## 18. First Prototype Target

The first prototype should prove this exact demo:

1. Host opens `main.tex`.
2. Host clicks "Host Session".
3. Guest joins on the same machine or LAN.
4. Host and guest type in the same file.
5. Remote cursors appear.
6. Host clicks Compile.
7. Both users see the PDF update.
8. Host closes app.
9. Guest gets "Session ended because host disconnected."

If this works, the core product is real.

## 19. Design Direction

The app should feel familiar to Overleaf users:

- Dense but clean editor workspace.
- File tree always visible.
- Compile button obvious.
- PDF preview always one click away.
- Logs easy to read.
- Collaboration presence visible but not distracting.

Avoid:

- Marketing landing page as first screen.
- Huge decorative hero UI.
- Card-heavy dashboard.
- Complicated account setup.
- Feature explanations inside the editor.

First screen should be the app:

- Open Project
- New Project
- Join Session
- Recent Projects

## 20. Open Questions

Important product decisions:

- Should guests need to install the desktop app, or can they join from a browser on the same LAN?
- Should host approval be required every time, or can invite codes auto-admit?
- Should clients keep local copies after a session?
- Should remote internet joining be an official feature or "advanced mode"?
- Should we bundle a LaTeX engine or require users to install one?
- Is visual editor mode required, or is code editor mode enough for v1?
- Do we want Git integration early?

My recommendations:

- Require the desktop app for MVP.
- Require host approval for v1.
- Do not keep client copies by default.
- Market v1 as LAN-first.
- Detect installed MiKTeX/TeX Live first; do not bundle TeX in the first build.
- Code editor only for v1.
- Add Git after snapshots are stable.

## 21. Biggest Risks

Connectivity risk:

- Same LAN is easy. Remote internet is hard without some relay, VPN, or port forwarding.

Compile safety risk:

- LaTeX is not just markup. It can execute commands if allowed and can expose host resources if poorly sandboxed.

Package size risk:

- Bundling a full TeX distribution can make the app enormous.

Compatibility risk:

- Overleaf projects may depend on specific TeX Live versions, custom packages, shell escape, minted/Pygments, Biber, fonts, or build recipes.

CRDT/file-system risk:

- Text collaboration is manageable. File rename/delete while others edit needs careful rules.

Expectation risk:

- "Same features as Overleaf" is a long roadmap. The MVP should focus on the loop that matters: edit together, compile together, no cloud bill.

## 22. Source Links

Research sources used:

- Overleaf feature overview: https://www.overleaf.com/about/features-overview
- Overleaf on-premises docs: https://docs.overleaf.com/on-premises
- Electron docs/homepage: https://www.electronjs.org/
- Tauri docs/homepage: https://tauri.app/
- Yjs docs: https://docs.yjs.dev/
- Yjs collaborative editor notes: https://docs.yjs.dev/getting-started/a-collaborative-editor
- CodeMirror docs: https://codemirror.net/docs/
- CodeMirror reference manual: https://codemirror.com/docs/ref/
- PDF.js: https://pdf.js.org/
- latexmk on CTAN: https://ctan.org/pkg/latexmk
- TeX Live: https://tug.org/texlive/
- MiKTeX: https://miktex.org/
- Tectonic: https://tectonic-typesetting.github.io/en-US/
- MDN WebRTC data channels: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
- MDN WebRTC protocols, ICE/STUN/TURN/SDP: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- libp2p NAT overview: https://docs.libp2p.io/concepts/nat/overview/
- TexLab language server: https://github.com/latex-lsp/texlab

## 23. Recommendation

Build the MVP as **Electron + React + CodeMirror + Yjs + latexmk + PDF.js**.

Do not start by modifying Overleaf Community Edition. It is too server-shaped for this idea. We can study its behavior, but our product should be designed around a temporary host session.

The right first milestone is not "full Overleaf clone". It is:

```text
Two students, same Wi-Fi, one host, one invite code, shared LaTeX editing, one compile button, shared PDF preview.
```

Once that works, we can grow the rest feature by feature.

## 24. Addendum: Internet Web App Without A Paid VPS

Clarification after revisiting the goal: the product should be an internet web app, not just a local/LAN app. That is possible, but a pure free-hosted web app cannot safely provide the whole Overleaf experience because full LaTeX compilation needs real compute, a filesystem, process execution, timeouts, and sandboxing.

The best no-monthly-payment architecture is:

```text
Browser frontend on free static hosting
        |
        | invite code contains tunnel URL + token
        v
Public HTTPS tunnel
        |
        v
Host Agent running on the host PC
        |
        +-- WebSocket collaboration server
        +-- Project filesystem
        +-- latexmk/Tectonic compiler
        +-- PDF/log broadcaster
```

In this model:

- The user-facing app is still a web app.
- GitHub Pages or Cloudflare Pages can host the static frontend for free.
- The host runs a small local helper/agent when they want to host a project.
- The helper starts a local collaboration and compile server.
- The helper exposes itself through a free tunnel such as Cloudflare Quick Tunnel, Tailscale Funnel, or ngrok free.
- Invite codes point guests to the temporary tunnel.
- When the host closes the helper or their PC sleeps, the room stops.

Why GitHub alone is not enough:

- GitHub Pages is static hosting for HTML, CSS, and JavaScript.
- It cannot run a persistent WebSocket collaboration server.
- It cannot run `latexmk`, TeX Live, MiKTeX, or Tectonic compiles.
- It cannot securely store and process active project sessions by itself.

Free hosting platform reality:

- GitHub Pages: good for static frontend only.
- Vercel/Netlify: good for frontend and request/response serverless APIs, but not ideal for persistent WebSocket rooms or LaTeX compile workers.
- Cloudflare Workers + Durable Objects: very promising for invite/session coordination and realtime rooms, but not for full LaTeX compilation on the free Worker runtime.
- Supabase Free: useful for auth, database, and realtime limits, but not for compiling LaTeX.
- Render Free/Railway trials/Fly trials: useful for prototypes, but free tiers are limited, sleep, expire, require cards, or are not reliable enough for the core product.
- Cloudflare Tunnel/Tailscale Funnel/ngrok: best match for the "host PC is the server, no VPS bill" idea.

The revised recommendation:

```text
Phase 1: Web app frontend + local host agent + Cloudflare Quick Tunnel
Phase 2: Invite codes, Yjs collaboration, host-side compile, PDF preview
Phase 3: Optional Cloudflare Worker directory service for nicer short codes
Phase 4: Optional paid/self-hosted deployment only for schools that want always-on rooms
```

This keeps the spirit of the original idea:

- No monthly VPS.
- Internet-accessible.
- Browser-based guest experience.
- Host controls the session.
- Session dies when the host stops.

The tradeoff is that the host must run an agent/helper. A browser tab by itself cannot reliably listen for inbound internet connections or run full native LaTeX compilation.
