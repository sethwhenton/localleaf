# LocalLeaf Implementation Plan

Date: 2026-04-30

Goal: build an MVP of LocalLeaf that proves the full host-powered internet workflow:

```text
Host installs LocalLeaf Host
Host opens a LaTeX project
Host starts an online session
LocalLeaf creates a temporary public invite link
Guests join from a browser
Everyone edits together
Host machine compiles LaTeX
Everyone sees PDF and logs
Host stops session
Room ends and files remain on host PC
```

## 1. MVP Definition

The MVP is not full Overleaf yet. The MVP is the smallest complete version that proves the product works.

MVP must include:

- Installable host app for Windows.
- Browser-based editor UI.
- Open existing project folder.
- Detect or configure main `.tex` file.
- Live collaborative editing for one `.tex` file first, then multiple text files.
- File tree display.
- Compile button.
- Host-side LaTeX compilation.
- PDF preview.
- Compile logs.
- Public invite link through tunnel.
- Guest join page.
- Host approve/deny join request.
- Max user limit.
- Session health panel.
- Stop session flow.

MVP can skip:

- Accounts.
- Cloud storage.
- Payments.
- Visual editor.
- Track changes.
- Full history browser.
- Git integration.
- Rich templates.
- Mobile editing.
- Perfect sandboxing.
- Full offline editing for guests.

## 2. Final MVP User Experience

### Host First-Time Flow

1. Host downloads `LocalLeafSetup.exe`.
2. Host installs LocalLeaf.
3. Host opens `LocalLeaf Host`.
4. App runs setup checks:
   - compiler available
   - tunnel tool available
   - browser available
   - project folder permissions
5. Host opens or creates a project.
6. Host selects main `.tex` file if not detected.
7. Host clicks `Open Editor in Browser`.
8. Browser opens local editor at `http://localhost:<port>`.

### Host Session Flow

1. Host clicks `Host Online Session`.
2. App starts:
   - local web server
   - WebSocket collaboration server
   - compile service
   - tunnel process
3. App runs network preflight:
   - tunnel reachable
   - latency estimate
   - basic upload estimate
   - recommended collaborator count
4. App shows invite link.
5. Host sends link to friends.
6. Host approves join requests.
7. Host monitors:
   - users
   - network health
   - compiler status
   - sync status
   - tunnel status
8. Host clicks `Stop Session` or closes app.
9. Guests see session ended.

### Guest Flow

1. Guest opens invite link in browser.
2. Guest enters display name.
3. Guest clicks `Join Project`.
4. Host approves.
5. Guest enters browser editor.
6. Guest edits, chats, views PDF.
7. If host stops, guest sees session-ended screen.

## 3. Recommended Technical Stack

Use a monorepo.

Core:

- Language: TypeScript
- Host app shell: Electron
- Frontend: React + Vite
- Editor: CodeMirror 6
- Collaboration: Yjs
- Transport: WebSocket
- PDF preview: PDF.js
- Compile runner: `latexmk` first, Tectonic as bundled fallback/experimental engine
- Local process manager: Node child processes
- Package manager: pnpm
- Build/package: electron-builder
- Tests: Vitest + Playwright

Tunnel strategy:

- MVP default: Cloudflare Quick Tunnel through bundled or downloaded `cloudflared`.
- Secondary option: ngrok.
- Later option: Tailscale Funnel.

Why this stack:

- Electron makes local filesystem, process spawning, and packaging straightforward.
- React/Vite makes the UI fast to build.
- CodeMirror 6 is lighter and more controllable than Monaco for a custom browser editor.
- Yjs is proven for collaborative editing and awareness.
- PDF.js gives browser-native PDF preview.
- `latexmk` gives real LaTeX build behavior.

## 4. Repo Structure

Start with this structure:

```text
localleaf/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
  docs/
    architecture.md
    mvp-checklist.md
  apps/
    host/
      package.json
      electron-builder.yml
      src/
        main/
        preload/
        renderer/
      resources/
  packages/
    ui/
    editor/
    collab/
    session-server/
    compiler/
    tunnel/
    project-fs/
    shared/
  tests/
    e2e/
    fixtures/
      basic-latex-project/
```

For the current workspace, we can either build directly at repo root or create a `localleaf/` app folder. Recommendation: build directly in this repository root once implementation begins.

## 5. Major Components

### Host App

Responsibility:

- Own the desktop window/control center.
- Open project folders.
- Start/stop services.
- Launch browser editor.
- Show session health.
- Show users and join requests.
- Manage tunnel process.
- Package everything for install.

Electron main process:

- App lifecycle.
- Window creation.
- IPC handlers.
- Project folder picker.
- Child process management.
- Local server startup.
- Tunnel startup.
- Compiler startup.

Electron renderer:

- Home screen.
- Project overview screen.
- Session status screen.
- Join request modal.
- Active session dashboard.
- Settings screen.

### Browser Editor

Responsibility:

- Run the Overleaf-like editor in browser.
- Serve both host local editor and guest tunnel editor.

Editor sections:

- Top toolbar.
- File tree.
- Code editor.
- PDF preview.
- Logs/messages/comments tabs.
- Chat.
- Users list.

### Session Server

Responsibility:

- Serve frontend assets.
- Accept WebSocket connections.
- Authenticate invite tokens.
- Handle host/guest roles.
- Broadcast Yjs updates.
- Broadcast awareness.
- Handle join requests.
- Enforce user limits.
- Broadcast compile status/PDF/logs.

Server APIs:

```text
GET  /health
GET  /join/:sessionCode
GET  /project/:projectId
POST /api/join-request
POST /api/join-approve
POST /api/compile
GET  /api/pdf/current
WS   /ws/session
```

### Project File System

Responsibility:

- Read project files.
- Write project files.
- Prevent path traversal.
- Watch file changes.
- Manage safe temp build directory.
- Ignore generated build files.

Rules:

- Never allow writes outside project root.
- Normalize and validate every path.
- Only expose allowed file types in MVP.
- Keep generated artifacts outside source folder.

### Compiler

Responsibility:

- Detect compiler.
- Run compile.
- Stream logs.
- Parse errors.
- Produce PDF artifact.
- Enforce timeout.

Initial compile command:

```text
latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1 main.tex
```

Compile stages:

1. Save pending edits.
2. Copy project to build directory or compile in safe build dir.
3. Spawn compiler process.
4. Stream logs to clients.
5. Detect success/failure.
6. Publish PDF bytes/version.
7. Clean temporary files when needed.

### Tunnel

Responsibility:

- Start Cloudflare Quick Tunnel.
- Capture public URL.
- Monitor process.
- Restart on failure if safe.
- Report tunnel health.

Example process:

```text
cloudflared tunnel --url http://localhost:<local-port>
```

Need to parse output for:

```text
https://something.trycloudflare.com
```

MVP can require `cloudflared` bundled or downloaded during install.

### Collaboration

Responsibility:

- Represent file text as Yjs shared text.
- Bind CodeMirror to Yjs.
- Sync through WebSocket.
- Show remote cursors.
- Track user awareness.

MVP Yjs model:

```text
project
  files: map path -> metadata
  activeTextDocs: map path -> Y.Text
  awareness: user name, color, active file, cursor
```

Simpler first step:

- Only `main.tex` collaborative.
- Then add multiple file support.

## 6. Phase Plan

### Phase 0: Project Setup

Deliverable: runnable skeleton.

Tasks:

- Initialize pnpm monorepo.
- Add Electron + React + Vite.
- Add TypeScript.
- Add lint/format scripts.
- Add basic app window.
- Add host home screen shell.
- Add browser editor route shell.

Acceptance:

- `pnpm install` works.
- `pnpm dev` opens host app.
- Host app can open a placeholder browser editor.

### Phase 1: Single-User Local Editor

Deliverable: local Overleaf-like editor without collaboration.

Tasks:

- Implement project folder picker.
- Read file tree.
- Detect `.tex` files.
- Select main file.
- Open editor in browser.
- Add CodeMirror editor.
- Save edits to disk.
- Add compile button.
- Run compile.
- Show logs.
- Display PDF using PDF.js.

Acceptance:

- Open fixture LaTeX project.
- Edit `main.tex`.
- Click compile.
- PDF preview updates.
- Logs show success/failure.

### Phase 2: Host Control Center

Deliverable: host app dashboard like the UI mockup.

Tasks:

- Home screen:
  - New Project
  - Open Project
  - Recent Projects
- Project overview:
  - compiler status
  - network status placeholder
  - project size
  - recommended collaborators
  - Open Editor in Browser
  - Host Online Session
- Session status:
  - invite link placeholder
  - host quality
  - users count
  - compiler
  - tunnel
  - upload
  - latency
  - Stop Session
- Active session dashboard.

Acceptance:

- Host can move through all screens.
- Project status reflects real compiler/project checks where available.

### Phase 3: WebSocket Session Server

Deliverable: host can serve editor over local network/localhost with WebSockets.

Tasks:

- Create local Express/Fastify or native Node HTTP server.
- Serve editor frontend.
- Add WebSocket endpoint.
- Define session state.
- Define host token and guest token.
- Add join request flow.
- Add max users setting.
- Add session ended broadcast.

Acceptance:

- Host opens local editor.
- Guest browser opens local join URL.
- Guest requests to join.
- Host sees request.
- Host approves.
- Guest enters editor.
- Stop session disconnects guest.

### Phase 4: Yjs Collaboration

Deliverable: two browser clients edit same file live.

Tasks:

- Add Yjs document.
- Add CodeMirror/Yjs binding.
- Add WebSocket update relay.
- Add awareness state.
- Show remote cursors.
- Show users list.
- Persist Yjs text changes to host disk.
- Handle reconnect/resync.

Acceptance:

- Host and guest edit `main.tex` simultaneously.
- Text converges correctly.
- Remote cursors show.
- File saves on host disk.

### Phase 5: Compile Broadcast

Deliverable: compile once on host, all clients see results.

Tasks:

- Restrict compile execution to host service.
- Any editor client can request compile if allowed.
- Host service runs compile.
- Broadcast status:
  - queued
  - running
  - success
  - failed
- Broadcast logs.
- Broadcast PDF version.
- Clients refresh PDF.

Acceptance:

- Guest clicks compile.
- Host compiles project.
- Host and guest see same logs.
- Host and guest see updated PDF.

### Phase 6: Tunnel Integration

Deliverable: internet invite link.

Tasks:

- Bundle or locate `cloudflared`.
- Start Quick Tunnel.
- Parse public URL.
- Generate invite URL:

```text
https://<tunnel-url>/join/<session-code>
```

- Copy invite link button.
- Monitor tunnel process.
- Show tunnel status.
- Stop tunnel when session stops.

Acceptance:

- Host starts online session.
- Public tunnel URL appears.
- Guest on another network can open join page.
- Host approves guest.
- Guest edits and sees PDF.

### Phase 7: Network Health And Limits

Deliverable: host knows whether they can host well.

Tasks:

- Add session capacity rules:
  - max users default 5
  - project size warning
  - upload size warning
  - compile timeout
- Add connectivity checks:
  - tunnel reachable
  - latency ping
  - basic upload estimate
  - connection stability
- Add host quality score.
- Add recommendations:
  - Excellent: up to 5 users
  - Good: up to 4 users
  - Fair: up to 2 users
  - Weak: host should avoid large sessions
- Add warnings for:
  - laptop on battery
  - sleep mode
  - tunnel disconnected
  - compiler missing

Acceptance:

- Session dashboard shows real status.
- Weak conditions produce clear warnings.
- User limit is enforced.

### Phase 8: MVP Polish

Deliverable: inspectable MVP.

Tasks:

- Improve UI spacing, typography, and empty states.
- Add LocalLeaf branding.
- Add guest join page.
- Add session ended page.
- Add chat MVP.
- Add file tree create/rename/delete if time allows.
- Add download project zip if time allows.
- Add app settings.
- Add error screens.
- Add first-run onboarding.

Acceptance:

- A new host can understand what to do.
- Guests can join without explanation.
- Common failures have clear messages.

### Phase 9: Installer

Deliverable: installable Windows build.

Tasks:

- Configure electron-builder.
- Build Windows installer.
- Include app resources.
- Include or download tunnel binary.
- Include optional Tectonic binary if chosen.
- Add desktop shortcut.
- Add app icon.
- Add signed build later if budget allows.

Acceptance:

- Install app on Windows.
- Open from Start Menu/desktop.
- Host a basic session.
- Uninstall cleanly.

### Phase 10: Testing And QA

Deliverable: confidence that MVP works.

Test layers:

- Unit tests:
  - path validation
  - invite token generation
  - session state
  - compiler command builder
  - tunnel output parser
- Integration tests:
  - open project
  - edit and save
  - compile fixture project
  - WebSocket connect/disconnect
  - join approval
- E2E tests:
  - host starts session
  - guest joins
  - two clients edit
  - compile broadcast
  - host stops session
- Manual tests:
  - Windows install
  - another browser
  - another computer
  - another network through tunnel

Acceptance:

- MVP demo works from fresh install.
- Known limitations are documented.

## 7. MVP Technical Detail

### Invite Code Format

Use a short visible code plus signed token internally.

Visible:

```text
ABCD-72KQ
```

Invite URL:

```text
https://<tunnel>/join/ABCD-72KQ?t=<token>
```

Server stores:

```ts
type Invite = {
  code: string
  tokenHash: string
  sessionId: string
  role: "editor" | "viewer"
  expiresAt: number
  maxUses: number
  usedBy: string[]
}
```

### Session State

```ts
type SessionState = {
  id: string
  projectName: string
  projectRoot: string
  mainFile: string
  status: "starting" | "live" | "stopping" | "ended"
  publicUrl?: string
  maxUsers: number
  users: SessionUser[]
  joinRequests: JoinRequest[]
  compilerStatus: ServiceStatus
  tunnelStatus: ServiceStatus
  syncStatus: ServiceStatus
  networkHealth: NetworkHealth
}
```

### User Roles

MVP roles:

- Host: full control.
- Editor: edit files, request compile.
- Viewer: view only.

Later roles:

- Reviewer: comments only.
- Co-host: can approve users and compile.

### Compiler Detection

Detection order:

1. User-configured compiler path.
2. `latexmk` on PATH.
3. Tectonic bundled binary.
4. Prompt user to install MiKTeX/TeX Live.

MVP should work with bundled Tectonic for simple projects, but `latexmk` should be the preferred compatibility path.

### File Safety

Implement these before file editing:

- `resolveProjectPath(projectRoot, relativePath)`
- Reject absolute paths from clients.
- Reject `..` traversal.
- Reject reserved device names on Windows.
- Restrict hidden/system paths if needed.
- Enforce max file size.

### Compile Safety

MVP protections:

- Compile timeout, default 60 seconds.
- Disable shell escape by default.
- Compile in isolated build directory.
- Do not expose host environment variables unnecessarily.
- Kill child process tree on timeout.
- Warn before compiling untrusted projects.

Later protections:

- Windows Job Objects.
- Restricted user token.
- Docker/WSL sandbox option.

## 8. UI Implementation Checklist

Host app screens:

- Home
- Project Overview
- Session Status
- Join Request
- Session Active
- Settings
- First-run setup

Browser screens:

- Join Page
- Waiting for Approval
- Editor
- Session Ended
- Connection Lost/Reconnecting

Editor UI:

- File tree
- Code editor
- PDF preview
- Compile button
- Logs tab
- Chat tab
- Comments placeholder
- User list
- Status indicator
- Top toolbar

Session health UI:

- Host quality bar
- Upload speed
- Latency
- Tunnel status
- Compiler status
- Sync status
- Users count
- Recommendation text

## 9. MVP Demo Script

The MVP is ready when this script works:

1. Install LocalLeaf Host.
2. Open LocalLeaf.
3. Open fixture project `basic-latex-project`.
4. Click `Open Editor in Browser`.
5. Edit title in `main.tex`.
6. Click `Compile`.
7. PDF updates.
8. Click `Host Online Session`.
9. Public invite link appears.
10. Open invite link in another browser/device.
11. Enter name `Ben`.
12. Host approves Ben.
13. Ben edits introduction.
14. Host sees Ben's cursor.
15. Ben clicks compile.
16. Both clients see compile logs.
17. Both clients see updated PDF.
18. Host stops session.
19. Ben sees session-ended page.
20. Host verifies project files saved locally.

## 10. Risks And Mitigations

### Tunnel Reliability

Risk: free tunnel URL changes or drops.

Mitigation:

- Show tunnel status.
- Auto-restart tunnel.
- Regenerate invite link.
- Tell users when link changes.

### LaTeX Compatibility

Risk: Tectonic cannot compile every Overleaf project.

Mitigation:

- Support `latexmk` with MiKTeX/TeX Live.
- Store compiler recipes.
- Show clear compiler setup status.

### Host Upload Speed

Risk: PDF preview is slow for guests.

Mitigation:

- Limit PDF broadcast frequency.
- Compress or cache PDFs where possible.
- Show network health.
- Limit users.

### Security

Risk: malicious project or guest abuses host machine.

Mitigation:

- Path validation.
- Compile timeout.
- Disable shell escape.
- Host approval.
- Max file sizes.
- Trusted-session warning.

### Sleep/Battery

Risk: host laptop sleeps and kills session.

Mitigation:

- Show battery status.
- Warn if not plugged in.
- Optional prevent sleep while hosting.

## 11. Suggested Build Order

Build in this order:

1. Single-user local editor.
2. Compile and PDF preview.
3. Host dashboard.
4. Local WebSocket server.
5. Join request flow.
6. Yjs collaboration.
7. Compile broadcast.
8. Tunnel link.
9. Session health.
10. Installer.

Reason:

- If compile/PDF is broken, collaboration is not useful.
- If local collaboration is broken, tunnel adds noise.
- If tunnel works before health UI, users will not understand failures.

## 12. Definition Of Done For MVP

MVP is done when:

- Host can install and run app.
- Host can open a LaTeX project.
- Host can edit and compile locally.
- Host can start an internet session.
- Guest can join from browser.
- Host can approve guest.
- Host and guest can collaboratively edit.
- PDF/log updates reach both users.
- Host can stop session.
- Files stay on host PC.
- App clearly explains connection/compiler problems.

## 13. Post-MVP Roadmap

After MVP:

- Multiple file collaborative editing.
- Better file operations.
- Comments.
- Snapshots/history.
- Project zip import/export.
- Templates.
- SyncTeX click source/PDF.
- TexLab autocomplete and diagnostics.
- Better compile sandbox.
- Host migration.
- Optional school/self-hosted deployment.
- Optional Cloudflare Durable Object short-code directory.
- Optional built-in updater.

