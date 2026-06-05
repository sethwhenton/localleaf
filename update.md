# LocalLeaf Major Update Plan

Last updated: 2026-06-05.

## Executive Direction

LocalLeaf has a strong product shape: a host-owned Overleaf-style room where students can open a LaTeX project, share a temporary browser link, approve collaborators, compile locally, and stop the session when they are done.

The main thing to change is the core collaboration model. Today the app behaves like a polished MVP: a large monolithic client, a large monolithic server, whole-file sync, synchronous disk writes, and several user flows layered on top. For the app to feel smooth, light, and trustworthy, the next version should be built around a real document-update layer, a narrower host/public API boundary, queued worker jobs, and a simpler host dashboard.

Recommended core: keep the host-owned local-session model, but replace whole-file snapshot editing with either:

- `@codemirror/collab` for the shortest robust host-authoritative path.
- Yjs for a fuller CRDT document layer with awareness/presence and future offline/reconnect strength.

Do not make InstantDB the core editor text-sync engine unless LocalLeaf intentionally changes from "host owns the project and guests need no account" to "cloud-backed collaborative documents." Instant can still be useful later for optional account-backed metadata, presence, permissions, or cloud relay features.

## Current State

The app is a single npm/Electron/Node project.

- Root manifest: `package.json`
- Lockfile: `package-lock.json`
- Local desktop entry: `src/desktop/main.js`
- Local server: `src/server/index.js`
- Client app shell: `public/app.js`
- CodeMirror editor source: `src/client/editor.js`
- PDF preview source: `src/client/pdf-preview.js`
- Compile/runtime helpers: `src/server/compiler.js`, `src/server/safe-path.js`
- AI/model helpers: `src/server/ai-models.js`, `src/server/cursor-agent.js`
- Workflows: `.github/workflows/*.yml`

Current collaboration behavior:

- Browser editor opens a `/collab` WebSocket, sends `open_file`, and sends whole-file `edit` messages.
- Client also schedules delayed HTTP saves, so WebSocket edits and HTTP saves can race.
- Server writes full file contents synchronously and broadcasts whole-file updates.
- SSE also carries file/state/session/chat/compile events, so file changes have more than one delivery path.
- Remote CodeMirror application computes a local diff from incoming full text, but this is still snapshot application rather than operation merge.

Current AI behavior:

- AI is host-mediated and proposal-based, which is the right high-level direction.
- Local models are optional downloads and run through bundled llama.cpp.
- Hosted providers can receive current file/project/compile context when configured.
- AI proposals store full before/after text in memory and are applied through host approval paths.

Current product behavior:

- Product promise is clear in copy: "Free. Local. Yours." and "hosted by you."
- The in-app journey is more fragmented: Home, Project Overview, Session Management, Editor, Settings/Models, AI Helper, and Changes compete for attention.
- AI setup is visible early and can distract from the simpler sharing/compiling workflow.

## What Could Have Been Better

1. The editor sync layer should have been operation-based from the start. Whole-file last-writer-wins sync is easy to demo but fragile under real multi-user editing.

2. The server should have been split earlier into a local control API and a narrow public collaboration API. A tunnel should not expose more host surface than guests need.

3. Compilation should have been a queued, cancellable worker from the first collaborative release. LaTeX is executable content, not just text.

4. Client state should have been modularized before the app grew. `public/app.js` now mixes routing, editor state, AI sessions, sharing, model settings, compile state, and UI rendering.

5. The first-run journey should have stayed centered on project, compile, share, approve, write. AI is valuable, but it should feel optional.

6. Product/design source of truth should be cleaned up. `DESIGN.md` is not a LocalLeaf design system, and `context.md` is stale relative to `README.md` and `projectcontext.md`.

## Core Architecture Proposal

### 1. Realtime Document Layer

Replace whole-file `edit` messages with a first-class document-update layer.

Recommended path A: `@codemirror/collab`

- Best fit if LocalLeaf remains host-authoritative.
- Server maintains per-file version history and current document text.
- Clients send versioned updates.
- Server accepts, rebases, or rejects stale updates.
- Reconnect asks for current version and missing updates.
- HTTP saves and AI edits must go through the same authority.

Recommended path B: Yjs

- Best fit if LocalLeaf needs richer presence, reconnect behavior, and future offline tolerance.
- One `Y.Doc` per project or one per open text file.
- One `Y.Text` per editable text file.
- Awareness carries active file, cursor, selection, name, color, and status.
- Server relays updates, persists debounced snapshots/update logs, and authorizes access.
- Disk is a persistence target, not the live collaboration authority.

Do not keep:

- Full-file write on every keystroke.
- Delayed HTTP save that can overwrite newer WebSocket edits.
- Name-based stale-update filtering.
- File change delivery split across SSE and WebSocket without one canonical document authority.

Required tests:

- Two users editing same line concurrently.
- Two users editing different ranges concurrently.
- Stale delayed save after another user edit.
- Reconnect after missed updates.
- Slow client/backpressure.
- Large file typing.
- Rename/delete while another client edits.
- AI proposal apply against changed document.

### 2. Host/Public API Boundary

Split server capability surfaces:

- Local control API: loopback only, host token only, project import/export/settings/model download/update checks.
- Public collaboration API: tunnel-safe, guest token/session scoped, only editor/chat/presence/join/compile if host permits.

Immediate direction:

- Bind local server to `127.0.0.1` by default.
- Make tunnel forwarding explicit.
- Keep guest tokens scoped to one active session.
- Add per-route capability labels: host-only, approved guest, pending guest, public static asset.
- Prefer host-only compile until compile isolation is strong enough for guest-triggered compiles.

### 3. Project Storage And File Index

Introduce a project repository layer instead of scattering direct filesystem access.

Responsibilities:

- Stable project ID.
- Stable file/document IDs independent of path.
- Incremental file index with size, mtime, type, hash, and dirty state.
- Atomic writes through temp file and rename.
- Safe rename/delete/create events integrated with live document state.
- Snapshot and backup policy.
- Import/export jobs that stream or run off the main event loop.

### 4. Compile Worker Queue

Move compile work into a single controlled job queue.

Required behavior:

- One active compile per project.
- Latest-wins cancellation.
- Job IDs and stale-result suppression.
- Compile log chunks as events.
- Resource limits and timeout.
- Clean environment allowlist.
- No shell escape.
- `latexmkrc` remains blocked unless explicitly trusted.
- Guest-triggered compile is opt-in, or host-only by default.

Longer term:

- Compile in a scratch copy rather than live project root.
- Consider sandboxing per platform.
- Detect compiler availability and show first-run readiness before sharing.

### 5. Client Modularization

Split `public/app.js` into small modules before adding the new sync core.

Suggested modules:

- `app-state`
- `routes`
- `api-client`
- `session-client`
- `collab-client`
- `project-store`
- `editor-controller`
- `compile-controller`
- `ai-controller`
- `settings-controller`
- `ui/render-*`

State model:

- One canonical app state store.
- Commands mutate state; renderers consume state.
- Network adapters emit typed events.
- Editor document state lives in the collaboration layer, not generic UI state.

### 6. AI Helper

Keep AI optional, host-mediated, and proposal-first.

Improve:

- Add SHA-256 verification for GGUF model downloads.
- Add idle shutdown for `llama-server`.
- Add thread/context caps so local AI does not compete too hard with compile and collaboration.
- Add explicit hosted-provider privacy notice near provider selection.
- Hide or clearly disable Cursor until its SDK can be bundled safely.
- Prune old proposals and cap proposal memory.
- During live sessions, keep approval-first default; make auto-apply host-only and clearly named.
- Disable automatic compile-repair loops during live collaboration unless host opts in.

### 7. Product And UX

North star: "Host a collaborative LaTeX room from your computer."

Primary journey:

1. Create/open project.
2. Compile once.
3. Start sharing.
4. Copy invite link.
5. Approve guests.
6. Write/chat/compile.
7. Export or stop session.

Overhaul:

- Collapse Home, Project Overview, and Session Management into one Host Dashboard.
- Host Dashboard zones: Project, Sharing, Readiness.
- Rename "Host Online Session" to "Start sharing" or "Create invite link."
- Move AI setup out of first-run and into Settings plus editor right rail.
- Rename `Changes` to `AI Changes`.
- Keep human chat visually first in live sessions.
- Simplify editor toolbar into groups: document, insert, search, layout.
- Hide advanced insert tools behind menus.
- Replace unclear labels like "Tree selected" with plain file/project state.
- Add empty states for no project, no compiler, no tunnel, no guests, and no active file.

Landing page:

- Lead with real screenshots.
- Add one plain hero sentence: "Open a LaTeX folder, share a temporary browser link, approve guests, and compile on your machine."
- Reduce fake overlays where screenshots already show the product.
- Emphasize local files, temporary link, host approval, local compile, and no accounts.

### 8. Supply-Chain And Release Safety

Keep the current read-only-first package-manager discipline.

Current npm hardening:

- `.npmrc` uses `min-release-age=7`.
- `.npmrc` uses `ignore-scripts=true`.
- `.npmrc` blocks Git, remote URL, local file, and directory dependency sources.
- `.npmrc` uses `engine-strict=true` and `strict-allow-scripts=true`.
- `package.json` pins the reviewed install-script packages in `allowScripts`.

Future package-manager decision:

- Staying on npm is acceptable with the current hardening if CI keeps npm `>=11.10.0`.
- Moving to pnpm 11 is attractive for stronger defaults, especially release-age, strict builds, and exotic subdependency blocking.
- If migrating to pnpm, add `pnpm-workspace.yaml` with:

```yaml
minimumReleaseAge: 10080
minimumReleaseAgeStrict: true
strictDepBuilds: true
blockExoticSubdeps: true
trustPolicy: no-downgrade
allowBuilds:
  electron: true
  esbuild: true
  electron-winstaller: true
```

Do not enable `dangerouslyAllowAllBuilds`.

Release safety:

- Keep third-party actions pinned to full SHAs.
- Keep top-level workflow permissions read-only.
- Keep write-token publish jobs separate from package-manager build jobs.
- Do not share dependency/build caches between untrusted PRs and trusted release jobs.
- Sign/notarize release artifacts when the app is ready for broader distribution.
- Verify update downloads by signature or checksum before opening installers.

## Phase Plan

### Phase 0: Stabilize And Measure

- Add line-level tests for current sync races before replacing the core.
- Add instrumentation for edit message size, write frequency, compile duration, import/export duration, and reconnects.
- Confirm local server bind behavior and tunnel behavior.
- Inventory stale docs/assets.

Exit criteria:

- Baseline tests prove current race cases.
- Metrics are visible in logs or a debug panel.
- Host API exposure is documented.

### Phase 1: Boundary And Storage Layer

- Create route capability map.
- Bind local control API to loopback.
- Introduce project repository/file index abstraction.
- Convert existing file APIs to repository layer.
- Add atomic writes.

Exit criteria:

- File operations go through one repository layer.
- Guest routes cannot reach host-only actions.
- Project tree updates are incremental.

### Phase 2: Realtime Sync Core

- Choose `@codemirror/collab` or Yjs.
- Implement per-file live document state.
- Replace full-text `edit` messages.
- Add acknowledgement/reconnect/resync.
- Route HTTP save, AI apply, compile reads, rename/delete through live document state.

Exit criteria:

- Concurrent edits merge correctly.
- Stale writes are rejected or rebased.
- Reconnect does not lose edits.
- Large files do not send full text on every keystroke.

### Phase 3: Worker Jobs

- Add compile queue.
- Add import/export jobs.
- Add cancellation and latest-wins behavior.
- Stream logs/events by job ID.
- Suppress stale results.

Exit criteria:

- Concurrent compile requests cannot interleave logs/PDF state.
- Slow imports/exports do not block collaboration.
- Guest compile policy is explicit.

### Phase 4: AI Lightening

- Verify GGUF downloads by hash.
- Add idle shutdown/thread caps.
- Prune/cap proposals.
- Add hosted-provider privacy UX.
- Remove or clearly disable unsafe/unbundled provider paths.

Exit criteria:

- Local AI does not stay hot forever.
- AI proposals cannot grow memory without bound.
- Hosted-provider data flow is clear to host.

### Phase 5: Product Flow Rebuild

- Build Host Dashboard.
- Simplify first-run states.
- Simplify editor toolbar.
- Rename sharing and AI tabs.
- Update landing page around real product evidence.
- Create a real LocalLeaf design system doc.

Exit criteria:

- A new user can understand project -> compile -> share -> approve from the first screen.
- AI is visible but optional.
- Product docs agree on version, promise, and workflow.

### Phase 6: Release Trust

- Sign/notarize app artifacts.
- Add checksum/signature verification for downloaded installers/updates.
- Keep binary/model hash verification current.
- Add release checklist for dependency review and workflow permissions.

Exit criteria:

- Release artifacts are verifiable.
- CI remains read-only by default.
- Package-manager policy is documented and enforced.

## Decision Notes

`@codemirror/collab` is the fastest coherent improvement because the app already uses CodeMirror and wants a central host authority. CodeMirror's official collaboration model is built around peers tracking versions, a central authority ordering changes, and rebasing/rejecting stale updates.

Yjs is the broader future-proof option. Yjs `y-websocket` uses a client-server model where the server distributes document updates and awareness information, and Yjs awareness is designed for online state such as cursor/user presence. This fits an Overleaf-like editor well, but it introduces more architecture than `@codemirror/collab`.

InstantDB is not wrong technology, but it is better aligned with realtime app data, optimistic/offline sync, permissions, storage, and account-backed products. It can help if LocalLeaf becomes cloud-backed or adds optional teams/accounts. It should not be the first choice for raw LaTeX text merge inside a host-owned no-account session.

## Immediate Backlog

1. Add loopback binding and explicit tunnel forwarding.
2. Add tests for concurrent edit/stale save before changing sync.
3. Choose `@codemirror/collab` vs Yjs for Phase 2.
4. Extract a small `collab-client` and `document-authority` without changing UI first.
5. Add compile queue and stale-result guard.
6. Create Host Dashboard design brief and LocalLeaf design system doc.
7. Add GGUF SHA-256 verification.
8. Decide whether to migrate npm to pnpm 11 or stay on hardened npm.

## External References Checked

- TanStack npm supply-chain postmortem: https://tanstack.com/blog/npm-supply-chain-compromise-postmortem
- npm v11 config docs: https://docs.npmjs.com/cli/v11/using-npm/config/
- pnpm settings docs: https://pnpm.io/settings
- CodeMirror collaboration example: https://codemirror.net/examples/collab/
- Yjs y-websocket docs: https://docs.yjs.dev/ecosystem/connection-provider/y-websocket
- Yjs awareness docs: https://docs.yjs.dev/api/about-awareness
- InstantDB about/architecture: https://www.instantdb.com/about
- InstantDB permissions: https://www.instantdb.com/docs/permissions
- InstantDB presence/topics: https://www.instantdb.com/docs/presence-and-topics
