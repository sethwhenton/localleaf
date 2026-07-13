# LocalLeaf Project Context

Last updated: 2026-07-13.

## Project Summary

LocalLeaf is a host-powered Overleaf-style collaboration app. The host installs and runs a local Electron/Node desktop app, opens a browser-based LaTeX editor, compiles PDFs locally, and can share a temporary collaboration link through a tunnel. Guests join from a browser and do not need the desktop app.

The repository is a single npm project:

- App name and version: `localleaf` `0.1.25`
- Entry point: `src/desktop/main.js`
- Local server: `src/server/index.js`
- Client editor sources: `src/client/editor.js` and `src/client/pdf-preview.js`
- Bundled browser assets: `public/`
- Packaging scripts and binary download helpers: `scripts/`
- Release output: `release/`
- Package manager state: `package.json` and `package-lock.json`

There are no npm workspaces, pnpm lockfiles, yarn lockfiles, or Bun lockfiles at the time of this note.

## AI Helper MVP Context

The editor has a right-rail AI Helper with three tabs: `Chat`, `AI Helper`, and `Changes`.

- Provider/runtime support currently uses the host-side provider/model manager in `src/server/ai-models.js`.
- LocalLeaf Local models are real GGUF downloads stored under the host's LocalLeaf model directory and served through the bundled llama.cpp `llama-server` runtime.
- `/api/agent/message` remains the non-stream fallback. It routes to an active OpenAI-compatible provider when configured, then LocalLeaf Local when a downloaded model is active, otherwise the deterministic local fallback.
- Hosted provider edits ask for compact exact replacement instructions first instead of requiring a full rewritten file, with a longer generation timeout for real edit requests than connection tests.
- If a hosted provider times out during an edit request, the route can create a safe deterministic fallback proposal for common LaTeX edits and exact `from ... to ...` replacement requests.
- `/api/agent/run` returns newline-delimited JSON events for the agent lifecycle: `run_started`, `tool_call`, `assistant_delta`, `proposal_created`, `approval_required`, `run_done`, and `run_error`.
- Read-only MVP tools are represented by host-side helpers for listing project files, reading a text file, and reading compile logs.
- File edits are proposal records stored in memory at `state.ai.proposals`.
- Mutating actions use approval endpoints: `/api/agent/approval/approve` and `/api/agent/approval/reject`. `/api/agent/proposal/apply` remains as a compatibility alias for approving a proposal.
- Safe edit enforcement is host-side: text files only, project-contained paths, base-hash protection, and no delete/rename/move/upload/shell/binary actions.
- The AI Helper chat renders approval cards. The Changes tab is history only with view, explain, copy diff, and open file actions.
- AI chat sessions are now host-persisted per project root through `src/server/ai-sessions.js`. The desktop app stores host sessions under the app-private `AiSessions` directory. Switching projects restores that project's host session list instead of reusing one global AI chat.
- AI chat sessions are identity-aware during live collaboration. The host still uses persisted project sessions, while approved editor guests get temporary in-memory AI sessions keyed by their live session identity. Guest AI session state is cleared when the host starts or ends a live session, and guests do not receive host provider settings, provider keys, model storage paths, or host chat history.
- AI session snapshots use schema v2. `/api/state` publishes session summaries only; create, activate, fork, rename, delete, and `/api/ai/sessions` responses include the active transcript detail. The store derives previews, message/change counts, revisions, run status, unread state, and the latest sanitized context usage. The 30-session ceiling is explicit and never evicts an older session automatically.
- `public/ai-session-state.js` is the testable browser state reducer for summaries, the active detail, per-session runs, mutations, and FIFO queued prompts. `public/app.js` binds that state to the UI and APIs instead of treating browser transcripts as persistence authority.
- Agent runs capture immutable run, message, and origin-session IDs. The host keeps a bounded, sanitized idempotency ledger that can replay a completed result even after its transcript messages age out, recovers stale running sessions as interrupted, blocks deletion of a running session, supports cancellation, and discards late completions. Switching, creating, and renaming remain available during a run; a background completion stays with its origin session and marks that session unread.
- AI edit proposals also capture the immutable originating project root/key and the pre-provider text snapshot used to build the request. Proposal approval, rejection, application, and reversion are refused while another project is active, and delayed hosted/Cursor results retain the original base hash so concurrent editor saves make the proposal stale instead of being overwritten, including in YOLO mode.
- The client allows one active model request per host/guest identity and queues later prompts FIFO with their originating session, model, permissions, file, and selection. Invalid supplied session IDs fail before provider invocation; missing IDs temporarily fall back to the requester's current session for compatibility.
- `src/server/ai-context.js` owns exact prompt assembly telemetry, UTF-8 byte-based token estimation, provider usage normalization, truncation metadata, and context-window calculations. Public `ContextUsageV1` data contains sanitized counts and enum metadata only; prompts, source excerpts, raw provider payloads, headers, and credentials are never included.
- Context occupancy is explicitly scoped to the last request because LocalLeaf rebuilds the prompt each time. Provider-reported token aliases are normalized when available; otherwise input usage is estimated from the exact serialized request. Hosted models may declare an optional validated context window, local models report the configured llama window, unknown capacities remain unknown, Cursor reports unavailable, and the deterministic fallback reports not applicable.
- Project AI change history is persisted separately through `src/server/ai-changes.js` under the app-private `AiChanges` directory. Host Changes shows AI proposals from the host and guests; approved guests see their own AI changes plus applied shared changes. Proposal records include requester metadata and are updated on proposed, applied, rejected, stale, and reverted transitions.
- PDF previews now support a SyncTeX-backed source-position lookup through `POST /api/pdf/source-position`. Successful compiles preserve the `.synctex.gz` path privately on the host while public compile state exposes only `sourceMapAvailable`.
- The editor PDF toolbar includes an Annotate mode. Normal PDF clicks try to jump to mapped LaTeX source; Annotate clicks open a compact popover and send page/coordinate/text/source context to AI Helper as a targeted edit request. This is not persistent PDF commenting in the MVP.
- PDF annotation AI requests are server-scoped to the mapped source block around the SyncTeX line. The provider prompt includes a line-numbered annotated source block, exact replacement instructions apply inside that block first, and provider `newText` that looks like a block rewrite is spliced into the annotated source instead of replacing the whole file.
- PDF annotation target preview supports both text and rendered image/figure regions. The client detects larger non-white PDF canvas regions for image annotations, outlines them in orange, and sends `elementType`, target rectangle, PDF coordinates, and SyncTeX source context so text-only providers can still edit figure/image LaTeX such as `\includegraphics`, captions, labels, sizing, and placement.
- Visual editor internals are CodeMirror-native, but the toolbar switch is currently reverted back to `Visual Editor soon`; Code mode remains the only exposed editor mode.
- Compile diagnostics are derived from compile logs and surfaced in the CodeMirror gutter/line highlights for the selected file while the original log dock remains available at the bottom.
- Normal PDF source navigation is single-click-to-source. Annotate mode remains explicit single-click targeting for AI annotation instead of source jumping.
- The previously added persisted Review tab/comment-thread surface has been removed. The right rail is back to `Chat`, `AI Helper`, and `Changes`; PDF annotation sends anchored context to AI Helper only.
- Legacy browser-local AI sessions are migrated once into the currently opened project. Session records keep message/proposal metadata but sanitize unexpected credential-shaped fields before writing JSON.
- Approval cards in the AI chat show their full diff preview without an inner scroll area, while the Changes tab remains an AI change history surface.
- AI Helper permission settings are stored client-side and sent with each AI request. They currently control hosted-provider routing, rewrite requests, ask-before-edit approval cards, YOLO/no-confirm auto-apply for safe text proposals, multi-file intent, and advanced request gates for file management, uploads/imports, shell commands, and binary files.
- The AI Helper timeline auto-scrolls to the latest message for active sessions and shows a floating jump-to-latest arrow when the user scrolls up. A compact header session bar opens a searchable, grouped session dialog with inline rename, fork, stop, and delete actions plus an adjacent New Session control. Native rename/delete prompts are gone; non-empty deletion uses a focus-trapped LocalLeaf dialog, and blank sessions delete directly. The minimalist treatment uses code-native 18px line icons, a short animated edge cue and quiet check instead of an orange selected-row block, flat neutral surfaces, and Default/YOLO kept separate in the composer.
- The model control combines a context ring, model name, and chevron. Its Model & context popover explains last-request token usage, capacity, included turns, truncation, estimated/measured state, stale-model state, and new-session guidance at high occupancy. Session, popover, transcript, and context transitions use short transform/opacity motion with immediate reduced-motion behavior.
- Advanced actions are still host-gated. When enabled, those requests can reach the active model; the deterministic local fallback only automates safe text proposals and otherwise returns an acknowledgement rather than executing shell/file-management operations directly.
- Cursor remains a provider template, but `@cursor/sdk` is intentionally not bundled in `0.1.18` because the current npm package pulls vulnerable transitive dependencies. Use LocalLeaf Local or an OpenAI-compatible provider for the release build.
- The AI Helper now sends recent conversation context and project-wide LaTeX context, so include files such as `includes/abstract.tex` can be edited even when another file is open.
- Search/replace supports current-file and all-file search, and project-wide Replace All is host-side through `/api/search/replace`.
- Settings uses the compact LocalLeaf design system. About is an icon-free editorial dialog with a text-led identity, two principles, a clear session model, six concise product details, honest current boundaries, and one accessible website action.
- The editor Workspace menu keeps only common workspace actions: the redundant disabled `Set as main file` row was removed, while alternate `.tex` files can still be made main from their file-tree context menu. `Check for updates` is a keyboard menu item with neutral styling, an orange animated underline, and visible completion feedback.
- The Appearance preference is a native keyboard switch with locally authored 18px/1.5px sun and moon SVGs, compositor-only motion, reduced-motion behavior, and forced-colors support. Provider connection/result badges use the compact 11px metadata scale and stay contained at 1024x640.
- LocalLeaf Local starts bundled llama.cpp with a 16k context by default and uses a smaller local-only AI prompt budget, so large projects do not exceed the default 4k model context. `LOCALLEAF_LOCAL_CONTEXT_SIZE` can override the runtime context size between 4096 and 32768.
- Release binary preparation now downloads pinned GitHub release asset URLs directly and verifies SHA-256, avoiding GitHub Releases API rate-limit failures in CI.
- Version `0.1.22` is an upload reliability release: image/PDF uploads now normalize Windows/macOS paths, save raw bytes, appear immediately in the Images panel, and are covered by server-flow regression tests.

Current focused verification after the AI Helper harness work:

```powershell
node --check public\app.js public\ai-session-state.js src\server\ai-sessions.js src\server\ai-context.js src\server\ai-models.js src\server\cursor-agent.js src\server\index.js
node --check src\client\editor.js public\editor.bundle.js
node --test tests\ai-context.test.js tests\ai-session-state.test.js tests\ai-sessions.test.js tests\ai-agent.test.js tests\ai-providers.test.js tests\server-security.test.js
node --test tests\*.test.js
git diff --check
```

The AI session/context focused gate passes 100/100 tests. The direct repository-wide Node test gate passes 191/191 with zero failures, skips, or cancellations. Browser acceptance passed create, switch, inline rename, confirmation cancel, keyboard Home/End/F2/Escape, the context popover, 220/280/340/540px rail widths, light/dark themes, reduced motion, forced colors, and zero console errors.

## Security Audit Context

This repository was audited for exposure to the May 2026 Mini Shai-Hulud npm supply-chain campaign and similar CI/package-manager compromise patterns.

Read-only audit evidence:

- No affected package namespaces were found in `package.json`, `package-lock.json`, source files, workflow files, or targeted local `node_modules` marker checks.
- No Mini Shai-Hulud markers were found: `router_init.js`, `router_runtime.js`, `tanstack_runner.js`, `execution.js`, `setup.mjs`, `@tanstack/setup`, `github:tanstack/router`, `bun run tanstack_runner.js`, or `A Mini Shai-Hulud has Appeared`.
- `package-lock.json` contains only npm registry tarball sources for package entries inspected; no Git, GitHub, direct tarball URL, `file:`, or `link:` dependency sources were found.
- npm marks three dependency packages with install scripts: `electron`, `esbuild`, and `electron-winstaller`.
- No npm publish, semantic-release, changesets, npm token, or trusted-publishing workflow was found.
- GitHub release workflows previously ran `npm ci` in jobs with `contents: write`; that has now been hardened.

Current verdict from the audit: likely not compromised, but hardening was required and has been implemented below.

## Implemented Supply-Chain Hardening

Package manager hardening:

- `.npmrc` now sets `min-release-age=7`.
- `.npmrc` now sets `ignore-scripts=true`.
- `.npmrc` now sets `engine-strict=true`.
- `.npmrc` blocks Git, remote URL tarball, local file tarball, and directory dependency sources with `allow-git=none`, `allow-remote=none`, `allow-file=none`, and `allow-directory=none`.
- `.npmrc` now sets `strict-allow-scripts=true` so unreviewed dependency install scripts become hard errors whenever scripts are not globally ignored.
- `package.json` declares Node/npm engine expectations: Node `>=22.19.0` and npm `>=11.16.0`. The npm floor is fail-closed because every dependency-source and install-script control in `.npmrc` must be understood, not silently ignored.
- `package.json` has a pinned `allowScripts` review allowlist for the only dependency packages currently marked with install scripts: `electron@41.3.0`, `electron-winstaller@5.4.0`, and `esbuild@0.28.1`.
- CI installs dependencies with `npm ci --ignore-scripts`.
- CI explicitly rebuilds only the known required install-script packages:
  - macOS: `electron`, `esbuild`
  - Windows: `electron`, `esbuild`, `electron-winstaller`
- CI pins Node `26.3.0`, which bundles npm `11.16.0`, and verifies that npm floor before dependency installation. This is the first pinned Node release used here that supports the complete `.npmrc` hardening set; no global npm replacement is performed in CI.

GitHub Actions hardening:

- Top-level workflow permissions now default to `contents: read`.
- Build jobs use read-only permissions.
- Release upload now happens in separate `publish` jobs with `actions: read` and `contents: write`.
- `GITHUB_TOKEN` is no longer passed to the binary download/build steps.
- `actions/setup-node` npm caching was removed from privileged release workflows.
- `actions/checkout` uses `persist-credentials: false`.
- Third-party GitHub Actions are pinned to full commit SHAs with version comments.
- The Pages workflow keeps `id-token: write` only on the deploy job where GitHub Pages needs it.

External binary hardening:

- `scripts/prepare-binaries.js` no longer downloads `latest` release assets.
- Tectonic is pinned to `tectonic@0.16.9` with SHA-256 checks for each packaged platform asset.
- cloudflared is pinned to `2026.3.0` with SHA-256 checks for each packaged platform asset.
- `scripts/install-tectonic.ps1` and `scripts/install-cloudflared.ps1` use pinned versions and verify SHA-256 before executing `--version`.

## Safe Operating Rules For Future Agents

Do not run these commands unless the user explicitly approves:

- `npm install`
- `npm ci`
- `pnpm install`
- `yarn install`
- `bun install`
- `npx`
- `pnpm dlx`
- package lifecycle, build, or packaging scripts

Safe static checks are preferred:

```powershell
git grep -n -I -e '@tanstack/' -e '@mistralai/' -e '@tanstack/setup' -e 'router_init\.js' -e 'tanstack_runner\.js' -e 'A Mini Shai-Hulud has Appeared' -- . ':!node_modules'
node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json','utf8')); for (const [p,v] of Object.entries(l.packages||{})) if (v.hasInstallScript) console.log(p,v.version)"
node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json','utf8')); for (const [p,v] of Object.entries(l.packages||{})){const r=v.resolved||''; if (r && !r.startsWith('https://registry.npmjs.org/')) console.log(p,r)}"
```

If local dependency installation is explicitly approved, use the hardened sequence:

```powershell
npm ci --ignore-scripts
npm rebuild electron esbuild electron-winstaller --ignore-scripts=false
```

On macOS, `electron-winstaller` is not needed for the macOS release path, so CI only rebuilds `electron` and `esbuild`.

## Remaining Security Notes

- There is no evidence requiring emergency secret rotation from this repository alone.
- Rotate GitHub, npm, cloud, Kubernetes, Vault, SSH, deployment, and CI secrets if a developer machine or runner installed an affected Mini Shai-Hulud package during the known attack windows or if any marker is later found.
- When bumping Tectonic or cloudflared, update both the pinned release tag and SHA-256 hashes in `scripts/prepare-binaries.js` and the Windows helper scripts.
- When adding dependencies, check whether the lockfile introduces `hasInstallScript`, Git/GitHub/tarball sources, or affected namespaces before allowing the change.
- When adding workflows, keep top-level permissions read-only, isolate write-token jobs from build/test/package-manager execution, and pin actions to full SHAs.

## Major Overhaul Handoff

### 2026-07-11 reliability and sharing batch

- PDF compilation is serialized through unique jobs and immutable source snapshots. Successful PDF/SyncTeX artifacts are published atomically, active streams retain references until they close, and a failed compile keeps the last good PDF with explicit stale metadata instead of replacing it with a broken artifact.
- Live-session compilation is host-only. The client now waits for a correlated WebSocket save acknowledgement before starting a compile, so the HTTP compile request cannot overtake the host-authoritative edit/save messages on the same live document.
- PDF preview loading has bounded transient retries, cancellable PDF.js loading/render tasks, explicit Retry/Open PDF recovery actions, and stale-last-good labeling.
- Invite-link generation accepts either an explicit provider preference or Automatic mode. Only one verified link is presented at a time, replacement invalidates the old link immediately, stale provider races are ignored, and pending/verifying/failure states are visible and truthful.
- Anonymous public state is capability-minimal; approved guests receive only the state needed for their role. Server and Electron control traffic binds to loopback, renderer IPC/navigation is origin-checked, join queues are bounded, invite codes use cryptographic randomness, and public tunnel verification requires a per-attempt challenge response.
- Project switching is blocked while sharing and is prepared before the current compile artifact is retired. Unsafe Windows path forms (reserved punctuation, ADS colons, and trailing dots/spaces) are rejected.
- Landing-page preview and AI sticky stages are observer-driven and compositor-friendly. The five-step collaboration story is intentionally static and responsive, with no scroll-driven state. The header was intentionally not changed. Desktop remains the supported application layout.
- Dependency patches in this batch: `ws@8.21.0`, `axios@1.18.1` override, `form-data@4.0.6` override, `esbuild@0.28.1`, and `electron-builder@26.15.3`. The lockfile-only PMG audit reports zero known vulnerabilities.
- Focused verification now includes compiler queue/artifact tests, collaboration/session/security server flows, safe-path tests, syntax checks, a production client rebuild, and desktop visual checks of the main app and landing page.
- `.github/workflows/ci.yml` now gates pull requests and `main` pushes with read-only permissions, PMG-protected lockfile installation, narrowly reviewed Electron/esbuild lifecycle rebuilds, repository-wide JavaScript/MJS syntax checks, the generated-client build, every `tests/*.test.js` regression/integration test, a generated-bundle freshness check, and the bounded rendered Electron gate on Linux/Xvfb and Windows.

Remaining architectural work:

- Whole-file collaboration is still last-writer-wins. Replace it with versioned operations or CRDT/OT before claiming conflict-safe concurrent editing.
- Compiler flags/environment are hardened, but true hostile-document isolation still requires a separate restricted worker/container with CPU, memory, filesystem, process, and network limits.
- The updater restricts download origins but still needs signed release metadata or an independently trusted checksum/signature before opening an installer.
- Split tunnel lifecycle, compile coordination, and collaboration state out of `src/server/index.js` as those subsystems evolve.

### 2026-07-11 landing, sharing, and compile follow-up

- The landing page's Choose / Host / Invite / Write / Stop section is a static editorial field-manual spread. It uses a large, sanitized capture of the real LocalLeaf Home screen and keeps all five steps visible without sticky scroll state, device choreography, or automatic motion. Narrow layouts turn the five-column index into readable rows.
- AI slide changes ignore duplicate scroll callbacks, preload the current theme's images, animate only the copy and image frame with short transform/opacity transitions, and keep progress indicators at a fixed width to avoid layout work.
- The landing preview has three reachable screens, three labels, and three progress dots. Keyboard focus is explicit, the existing header behavior and Inter font stack are unchanged, while preview and AI surfaces use flat neutral backgrounds rather than orange gradients.
- The three collaboration-promise statements use a one-shot IntersectionObserver reveal with short staggered opacity/translate transitions. Reduced-motion mode renders them immediately with no transition.
- Invite-link UX uses a durable Settings default plus an ephemeral per-session override. It deliberately displays one verified link instead of several competing URLs, shortens it only visually, keeps the full URL on Copy, and distinguishes generating, verifying, ready, replacement, and failed states.
- Cloudflare Quick Tunnels do not support Server-Sent Events. Compile and chat project events are therefore mirrored through the existing collaboration WebSocket so approved browser guests receive deterministic compile/PDF updates even when the selected tunnel drops SSE.
- Collaboration saves now include the intended document text and receive a correlated acknowledgement only after the host has successfully written that content. A write failure cannot masquerade as a successful save before compile.
- Missing, incomplete, or corrupt PDF artifacts are never advertised as downloadable output. Failed compiles retain a last-good PDF only while its artifact still exists, and timeout/signal exits can no longer normalize to success.
- Starting a second host session while one is live is rejected. Refreshing an invite rotates its join code so the previous URL cannot authorize a new request. Existing approved tokens remain valid, though the current break-before-make tunnel replacement can still make connected browsers reconnect.
- Compiler artifact names and included-source discovery now handle uppercase or mixed-case `.TEX` extensions. Both `latexmkrc` and `.latexmkrc` are treated as executable project configuration and cause latexmk to be skipped unless the host explicitly opts in.
- Tunnel URLs are parsed from bounded accumulated process output so URLs split across stdout chunks are still recognized.
- Reusing an SSE client ID cannot let an older closing request unregister its replacement connection. Guests with a healthy collaboration WebSocket also no longer see a false SSE reconnect warning on providers that do not support EventSource.
- Existing PDF files are revalidated before state publication, stale fallback, source mapping, inline serving, and export; an artifact that becomes corrupt is no longer advertised as last-good.
- Compiler subprocess output has a hard per-process byte budget; the final multi-engine/multi-pass log aggregate is also capped before it reaches HTTP, SSE, WebSocket, or the renderer.
- The Electron host uses an operating-system-assigned loopback port and a single-instance lock. Renderer preferences are sanitized and persisted in the app-private `renderer-preferences.json`, so theme, layout, provider, and permission choices survive port changes and app restarts.

Focused verification for this follow-up:

```powershell
node --check landing-page\script.js public\app.js src\server\index.js src\server\compiler.js
node --test tests\compiler.test.js tests\server-flow.test.js tests\server-security.test.js tests\safe-path.test.js
```

The final repository-wide Node test run for this batch passed 88/88 tests.

Still recommended:

- Critical project state, compile, chat, file, presence, and session events now reach the WebSocket. Consolidate their remaining message shapes into one versioned protocol and keep SSE only as an optional compatibility path.
- Replace whole-file last-writer-wins editing with `@codemirror/collab` operations or a Yjs document layer before describing concurrent edits as conflict-safe.
- Run LaTeX in a separately constrained worker/container with cancellation and CPU, memory, process, filesystem, and network limits.
- Virtualize PDF pages and compile logs for very large documents. Pane resizing is already frame-batched and writes preferences only on pointer-up.
- Browser and desktop-sized visual QA was completed at 1440x900 for Home, Session, Editor/PDF, Settings, Help/About, and the landing page. Final browser checks reported zero console errors or warnings.

The next architectural focus is documented in `update.md`. The short version:

- Product north star: LocalLeaf should be a lightweight host-owned LaTeX writing room: open/create project, compile locally, start sharing, approve guests, write/chat/compile, export, stop.
- Realtime core: the current collaboration model is host-authoritative whole-file snapshot sync. Replace it with versioned operations through `@codemirror/collab` or a Yjs document layer; do not move core editor sync to a cloud service unless the product intentionally changes away from host-owned sessions.
- Host boundary: bind local control APIs to loopback, keep public tunnel APIs narrow, and make guest capabilities explicit.
- Compile/import/export: move heavy work into queued worker jobs with cancellation, stale-result suppression, resource limits, and safer LaTeX isolation.
- AI helper: keep AI optional and host-mediated. Add SHA-256 checks for GGUF downloads, idle shutdown/thread caps for `llama-server`, explicit hosted-provider privacy copy, and proposal pruning.
- UX: collapse Home, Project Overview, and Session Management into a Host Dashboard; rename sharing actions in plain language; move AI setup out of first-run; simplify the editor toolbar.
- Design docs: `DESIGN.md` now has one authoritative LocalLeaf frontmatter contract. The old Ollama/SF Pro/black-pill component inventory was removed; only a short non-authoritative history note remains. Update or retire the stale `context.md` before a full UI rebuild.

### 2026-07-11 final desktop UI, PDF, and security follow-up

- The desktop application now self-hosts Geist under the OFL and uses a compact minimalist system: `#181818` primary text, `#6A6A6A` secondary text, a 4px spacing scale, 8/12/16/24/40px radii, 14px reading/control text, 18px titles, and mostly 18px licensed Phosphor-derived glyphs in 24px bounds. The landing page remains on its original Inter stack so its header is unchanged.
- Home, Session, Settings, Help, About, the workspace menu, and editor chrome were flattened and tightened. The LocalLeaf mark/icon assets were rebuilt, and third-party font/icon notices live in `THIRD_PARTY_NOTICES.md`.
- AI Helper input supports safe Markdown formatting for bold, italic, inline code, code blocks, lists, and HTTPS links. Assistant output renders the same supported subset semantically while escaping raw HTML and refusing unsafe/credentialed links.
- Host Session intentionally shows one verified link, with a compact display value and adjacent Copy button. Settings stores the default provider, the session permits a temporary override, Refresh rotates the join code, Stop remains on the session screen, and Back is a separate action.
- PDF fetches use three bounded, cancellable attempts for retryable failures and do not retry non-retryable HTTP responses. The old whole-render deadline was removed so large valid PDFs can continue rendering progressively. Failed compiles retain and label the last validated PDF.
- Capability tokens are read into session storage and scrubbed from app-navigation URLs. Navigable PDF/export resources still use bearer query parameters and should move to short-lived, resource-scoped capabilities or Electron IPC downloads before a stricter security claim.
- Host compiler logs and guest state are bounded/redacted. Raw host paths are not exposed to guests, per-process and aggregate log budgets prevent renderer/network floods, and compiler processes inherit an allowlisted environment. POSIX process-tree termination remains a follow-up.
- Desktop renderer preferences are synchronized through origin-validated preload IPC to an app-private JSON file, allowing the HTTP server to use a fresh loopback port without losing UI/provider settings.
- Modal focus is trapped and restored, settings tabs are keyboard-aware, and the editor More menu supports focus entry plus Arrow/Home/End navigation.
- CI uses read-only permissions, SHA-pinned actions, PMG on Linux, a Windows build/test smoke job, JavaScript/MJS syntax checks, a generated-client freshness gate, every Node regression/integration test, and a real sandboxed Electron/PDF.js renderer gate. The rendered gate uses the existing product Electron rather than adding a browser-test dependency.
- A read-only improvement audit informed the current security and reliability backlog; it did not silently rewrite application source.

Final validation for this batch: `pmg npm test` passes 88/88 tests after rebuilding all browser bundles; repository JavaScript/MJS syntax and `git diff --check` pass; browser QA confirms invite rotation, Stop/Back separation, safe Markdown formatting, successful PDF rendering, last-good fallback after a failed compile, token scrubbing on app navigation, focus restoration, and zero console errors/warnings.

### 2026-07-11 provider, AI writing, inverse search, and viewport follow-up

- LocalLeaf uses `#C95100` with white text for primary actions in both themes; the original `#FF6700` stays on the logo mark. Selected navigation, tabs, and segmented controls use neutral surfaces/text with a persistent 2px orange underline only. Repeated provider Connect actions remain quieter, and destructive actions remain semantic red.
- OpenAI, OpenRouter, Ollama, LM Studio, Cursor, and OpenCode marks are reviewed, locally hosted assets from the pinned `ln-dev7/logos-apps` catalog. Runtime hotlinking is not used. `DESIGN.md`, `THIRD_PARTY_NOTICES.md`, and `public/assets/provider-logos/NOTICE.md` record the source, commit, hashes, modifications, owner references, and per-mark redistribution conclusion. OpenRouter and Ollama still require permission or a generic-glyph substitution before a public distribution that requires an express logo grant.
- Development-time humanizer guidance informed the writing contract. The application does not execute a development skill at runtime; instead, `src/server/ai-response-style.js` applies a concise equivalent contract to hosted, local, Cursor, and deterministic AI paths.
- AI replies support the existing safe Markdown subset. Prose/article requests preserve the requested voice, facts, meaning, quotations, and citations while avoiding stock chatbot filler and fabricated claims. File proposals receive a sanitized, bounded, outcome-first lead that says the edit is prepared for review until it is actually applied.
- Normal PDF clicks perform inverse SyncTeX search. The displayed artifact identity is checked before and after mapping, unsafe or non-editable paths are rejected, late clicks are discarded, and each browser reveals/focuses its own mapped file and line without moving other participants. The preferred SyncTeX CLI runs asynchronously with a 2.5-second timeout, a 64 KiB output cap, `shell: false`, and a four-lookup ceiling; excess clicks receive a retryable busy state. PDF hyperlinks retain their normal behavior.
- Packaged builds no longer require a separately installed `synctex` executable for inverse search. LocalLeaf prefers the host executable when available, then runs its bundled, MIT-attributed JavaScript reader in a dedicated worker thread so decompression, parsing, and reverse search cannot block the HTTP/WebSocket event loop. The worker has the same 16 MiB compressed, 64 MiB inflated, one-million-line, and 500,000-record ceilings, retains at most one parsed artifact keyed by resolved path plus size/mtime, times out after 2.5 seconds, and is replaced cleanly after timeout or failure. Timeout/output-limit subprocess slots remain occupied until child close, with a bounded 500 ms kill-grace fallback.
- The editor root is contained to `100dvh`; workspace and log tracks shrink within the window, right-rail content scrolls locally, and compact desktop columns keep the AI composer reachable at supported laptop widths. The landing header and mobile scope were not changed.
- AI Helper user prompts no longer inherit the legacy dark-theme orange/brown full-row fill. The transcript row is explicitly transparent in both themes, while the prompt is a compact right-aligned neutral card with a sentence-case sender label and neutral hairline; rendered regression checks cover surface neutrality, width, alignment, contrast, and overflow.
- Changes Review now performs forward SyncTeX navigation from the proposal's first changed source line to the displayed PDF. It validates the immutable compiled source snapshot hash plus artifact/version before and after lookup, uses the bounded host CLI with a bundled worker fallback, opens the source transactionally, and reveals one restrained marker on the mapped PDF page. Missing, pending, stale, or unmapped PDFs keep the source open without moving the preview; repeated reviews are latest-request-wins. The Changes panel uses flat neutral run groups, semantic compact status tags, readable Geist Mono diffs, accessible code-native chevrons, and light/dark/reduced-motion/forced-colors parity.
- PDF source reveal is transactional: the exact mapped file must load and become current before LocalLeaf selects its source line. PDF HTTPS link hitboxes are rescaled immediately during progressive zoom.
- PDF annotation hover targeting is coalesced to one animation frame, reuses its outline element, and caches text geometry per artifact, render size, and zoom instead of measuring every span on every pointer event. Pane-resize style writes are also frame-batched, with local preferences persisted only when the drag finishes.
- Help disclosures use labelled Show answer / Hide answer controls with chevrons, native details semantics, keyboard operation, and restrained orange focus/icon treatment.
- Provider marks are keyed by exact built-in IDs; custom providers always receive the neutral generic mark even if their name or ID contains a company name. Only an explicit, validated built-in template selection can assign built-in provenance, and Custom opens a blank provider form.
- Deterministic AI rewrites are limited to one exact selected-text match and protect quoted/verbatim/LaTeX content. Proposal-card summaries are normalized to bounded plain text at the central record boundary.

Current integrated verification: `pmg npm test` rebuilds all browser clients and passes 191/191 tests with zero failures/skips at an explicit four-file concurrency ceiling. `pmg npm run test:rendered` passes 20 rendered checks covering host-auth startup, compact provider status, underline-only navigation, Help mouse/keyboard input, icon-free About, the accessible Appearance switch, human Chat and AI Helper message presentation in both themes, safe rich-text semantics, WCAG text contrast, workspace update/ZIP actions, computed primary-action states, PDF.js canvas render, progressive zoom geometry, resize-cancel cleanup, click-to-source file/line focus, visible retry recovery, last-good retention, and renderer console/process health. Its parity sweep checks Home, Project, Session, Editor, every Settings tab, Help, About, and the workspace menu in light and dark themes at both 1024×640 and 1440×900, including pane-local overflow, flat surfaces, dark-mode light leaks, selected-state underlines, reduced motion, and forced colors. Server tests use per-project AI session, change, model, and provider roots so parallel files cannot modify shared AppData. Every AI-session mutation carries a project key and rejects delayed cross-project requests/responses. JavaScript/MJS syntax checks, JSON/YAML parsing, and scoped `git diff --check` pass. Local npm 11.8 can still run existing scripts but intentionally reports the new hardening keys as unknown; installs and CI require the declared npm 11.16 floor.

Known limits:

- SyncTeX cannot map every blank/generated PDF region, and last-good PDF line numbers may lag live source edits until the host recompiles.
- AI writing guidance improves consistency but is not a trust boundary. The safe renderer and proposal review flow remain mandatory.

### 2026-07-11 Hildén-inspired landing redesign and Awwwards explorations

- `landing-page/` is now a complete editorial redesign informed by Hildén & Kaira's pacing, palette and motion language while retaining LocalLeaf's own product claims, logo, screenshots and generated artwork. The previous landing-page snapshot is preserved at `temp/landing-before-hilden-2026-07-11/`; the completed redesign is mirrored at `temp/localleaf-hilden-redesign/`.
- The hero uses one GPT-generated alpha PNG for the exact nine-letter `LOCALLEAF` balloon wordmark. CSS keeps its native 3:1 aspect ratio with `height: auto`, animates the whole asset through a transform/opacity pop, and disables the animation cleanly for reduced motion.
- The landing experience includes a fixed tone-aware header, focus-managed acid-lime mobile menu, parallax product prints, draggable workflow deck, scroll-staged product cards, rotating product principles, original cinematic collaboration imagery and real Windows/macOS release links.
- Instrument Serif is hosted locally under SIL OFL 1.1 as the editorial display face; Geist/Geist Mono remain the UI/body family. Font notices live in `landing-page/assets/fonts/NOTICE.md` and the Instrument license text is copied alongside the font.
- Six independent Awwwards-inspired studies are isolated under `temp/awwwards-variants/variant-1/` through `variant-6/`. They are exploratory frontends only and do not alter desktop-app behavior.
- Browser QA used the installed Playwright CLI Chrome channel because the browser connector was unavailable. The final 1440×1024 and 390×844 passes show zero overflow and zero console errors/warnings; the main workflow controls, principle carousel, mobile focus/Escape behavior and reduced-motion wordmark state pass. All six variants return HTTP 200, have no broken local references or browser errors/warnings, and their scripts pass `node --check`.
- Visual comparison and blocking browser QA passed before the landing redesign was accepted.
- Follow-up image treatment keeps every LocalLeaf UI capture at its source aspect ratio. The hero now uses two much larger, centrally overlapped and oppositely tilted product cards; the dark How it works cards are 88vw/1480px wide; the workflow rail presents near-full-viewport snap slides with working Previous/Next controls. Desktop and mobile media use `height: auto` plus `object-fit: contain`, and the actual How it works anchor is `#how`.

### 2026-07-11 project creation and AI-created LaTeX files

- Project Overview uses the original top-aligned dashboard flow and remains horizontally bounded within the desktop viewport. New Project is an accessible modal with an editable project name and destination path, a native Electron directory picker, pending/error states, focus trapping/restoration, and the existing orange primary-action contract. The landing header and mobile scope were not changed.
- The host exposes the real default projects directory only to the trusted host state. `POST /api/project/new` accepts `{ projectName, destinationDirectory, requestId }`, validates names and local absolute destinations, rejects the bundled starter tree and canonical linked aliases, rejects UNC/network paths, atomically reserves a unique child directory, cleans pre-commit failures, and makes identical retries idempotent instead of creating `Project 2`.
- AI Helper provider/local JSON now accepts `creates: [{ path, content, summary }]`; Cursor scratch diffs also detect new text files while excluding symlinks and hidden project state. Supported project-relative LaTeX source/support files are bounded to 256 KiB, validated against traversal/absolute/hidden/linked paths, and written through an exclusive identity-checked writer that never overwrites an existing file.
- New-file proposals are labelled `New file`, always require host approval even under YOLO, and open transactionally only after creation. Mixed create/edit runs force approval on every sibling, require every created dependency to exist with its approved hash before applying related edits, prevent individual create reversion while dependent edits remain applied, and support hash-checked all-or-nothing run Undo.
- Proposal operations are project/requester/session scoped. Run grouping and Undo use an anchor proposal so colliding run IDs from different participants cannot combine. Selected files are flushed before apply/revert/undo, deleted remote selections fall back to a surviving source file, compile repair uses fresh run IDs, and restart-only history is explicitly non-actionable rather than exposing broken Apply/Revert buttons.
- The minimalist design contract for Project creation and AI-created files is recorded in `DESIGN.md`. New Project rendered checks cover accessibility, editable destination fallback, orange action contrast, and centered containment at 1024x640 and 1440x900.

Integrated verification for this follow-up: `PMG_DISABLE_TELEMETRY=true pmg npm test` rebuilt all browser bundles and passed 231/231 tests with zero failures/skips. `PMG_DISABLE_TELEMETRY=true pmg npm run test:rendered` passed all 22 rendered checks, including New Project, top-aligned Project parity, PDF.js rendering, click-to-source, Review-to-PDF, retry recovery, last-good retention, and renderer health. JavaScript syntax and scoped `git diff --check` also pass. The local npm version still prints the previously documented warnings for future hardening keys; no install or dependency mutation was performed.

### 2026-07-11 Awwwards variant product-capture refresh

Cloudflare handoff: the six experiments are publicly deployed as the Direct Upload Pages project `localleaf-landing-lab`. The stable showcase is `https://localleaf-landing-lab.pages.dev/`, with experiments at `/variant-1/` through `/variant-6/`. The index and all six stable routes returned HTTP 200 after deployment.

- All six explorations under `temp/awwwards-variants/variant-1/` through `variant-6/` now use variant-local current LocalLeaf product captures rather than stale shared app screenshots. Each direction chooses the mode that fits its design: Variant 1 and Variant 4 use light captures; Variants 3, 5, and 6 use dark captures; Variant 2 retains both because its real theme toggle swaps every product portrayal coherently.
- Variant 3's Compile Current hero uses current dark Host, Session, and Editor captures plus `assets/compile-current-product-v3-dark.png`, a built-in GPT Image composite created from those exact current dark screens. Its Host, Link, Approve, and Compile chapters now reveal progressively with transform/opacity choreography as the desktop horizontal current advances; mobile cards reveal individually through IntersectionObserver. Reduced-motion renders every chapter immediately.
- Variant 1 adds three current captures inside stitched manuscript frames. Variant 2 uses fresh current 2576×1408 live Electron captures and theme-aware sources. Variant 4 uses a current 16:9 editor/AI approval specimen. Variant 5's five workflow states use dark current captures inside its industrial instrument frame. Variant 6's process and showcase interactions use five current dark captures.
- Final checks: every variant returns HTTP 200; all six scripts pass `node --check`; local image references resolve; no variant retains stale shared Home/Session/Editor asset references; desktop 1440×900 and mobile 390×844 passes report zero horizontal overflow, broken images, console errors, or warnings. Variant 3's desktop chapter opacity/current-state progression and mobile one-by-one reveal were verified directly.

### 2026-07-13 restrained desktop motion polish

- Project Overview is restored to its original top-aligned dashboard position while retaining its horizontally bounded desktop layout. New Project remains a centered modal.
- View changes use the shared 120–180ms motion scale. Editor sidebars, source/PDF panes, the right rail, and logs reveal in place without rebuilding the editor or animating grid dimensions. Dialogs and popovers use a restrained opacity/translate/0.98-scale entrance; buttons use a small press response; selected and hoverable navigation keeps the left-origin orange underline.
- Hosted-session readiness now uses four code-native signal bars. Animation is limited to pending/verifying states; ready, failed, ended, and idle states remain static and truthful.
- Motion uses explicit transform/opacity/color properties rather than `transition: all`, removes the old large-panel animated shadow, avoids animated blur, honors reduced motion and forced colors, and makes scripted scrolling instant when reduced motion is requested.
- Development-time `better-ui` guidance informed the restrained motion pass; it is not shipped or executed by LocalLeaf at runtime.

### 2026-07-13 session provider and editor diagnostics polish

- The Host Session provider choice is a code-native custom listbox with a compact selected-provider summary, a restrained floating menu, explicit per-session scope, Arrow/Home/End/Escape handling, focus restoration, disabled and pending states, reduced-motion behavior, and forced-colors support. Provider selection and Refresh-link server behavior are unchanged.
- The Files, Images, File outline, and Compile log surfaces now share the flat LocalLeaf desktop grammar. Text placeholders for file/image/disclosure icons were replaced with local 18px SVG glyphs; hierarchy guides, counts, warning/error summaries, pinned issues, and raw log rows use Geist/Geist Mono, neutral dividers, and semantic muted surfaces in light and dark themes.
- Existing file selection, rename, drag/drop, pane resizing, outline navigation, diagnostics pin/clear behavior, and pane-owned scrolling remain intact. No dependency or remote runtime asset was added.

Focused verification: `PMG_DISABLE_TELEMETRY=true pmg npm run test:rendered` passes the complete Electron renderer gate, including the provider listbox keyboard/focus contract, light/dark parity at 1024x640 and 1440x900, editor navigation/log containment, reduced motion, forced colors, PDF rendering/retry, and renderer health. JavaScript syntax and scoped `git diff --check` pass.

### 2026-07-13 custom provider dialog polish

- Add/Edit Custom Provider is a contained desktop form with distinct Provider details, Models, Optional headers, and Advanced context handling sections. It uses the LocalLeaf 4px rhythm, 8/12/24px radii, 18px code-native icons, one orange Save action, a neutral connection test, flat light/dark surfaces, and its own scroll region at short viewport heights.
- Hosted-provider context remains provider-managed. New model rows collect only the provider model ID and optional display label, while the form states, “Context window is managed by the provider.” Existing saved `contextWindowTokens` metadata is retained invisibly when a provider is edited so removing the arbitrary numeric control does not change request behavior or break saved models.
- Provider model IDs, existing display aliases (including legacy `{ id, name }` records), optional headers, and built-in template behavior are preserved. Model/header removal uses labelled SVG controls; the dialog is labelled/described for assistive technology; Escape closes only this nested dialog and restores focus instead of also closing Settings.

Focused verification: JavaScript syntax and scoped `git diff --check` pass. The rendered Electron gate passes the custom-provider accessibility, provider-managed-context compatibility, 40px target, contained-scroll, theme-pair, and focus-restoration checks. The earlier `#sessionTunnelProvider` dark-theme report was caused by overlapping Electron smoke processes; the final sequential gate is green.

### 2026-07-13 integrated context and UI consistency follow-up

- Hosted OpenAI-compatible requests leave the provider's context window at its default and never send `context_window`, `context_length`, or `num_ctx`. Hosted capacity is presented as **Provider managed** rather than as an arbitrary numeric setting.
- Bundled Qwen local models use a 32K model ceiling and an automatic 4K/8K/16K/32K memory tier. LocalLeaf reads llama.cpp's actual `/props` allocation before assembling the prompt, reserves output/safety capacity, bounds UTF-8 context, and runs local inference with one slot for predictable memory use. The environment override remains an advanced, clamped escape hatch.
- The AI composer is visually plain again: its formatting toolbar is removed while typed Markdown, safe rich assistant output, auto-grow, Enter-to-send, and Shift+Enter line breaks remain supported.
- Settings model disclosures now update their existing DOM in place, preserving modal identity, focus, scroll, persistence, and ARIA state. The custom-provider form, Host Session provider menu, Changes actions, search/replace controls, file/outline/log navigation, and context labels share the same flat neutral surfaces, orange action/underline contract, 18px glyphs, and 120–180ms transform/opacity motion in light and dark themes.
- No dependency or remote runtime asset was added. The landing header and unsupported mobile scope were not changed.

### 2026-07-13 transactional Files workflow and editor CTO audit

- New file and New folder are now transactional client drafts. LocalLeaf does not touch the host project until the user explicitly confirms; Escape or Cancel removes only the draft. Names are validated inline, extensionless files receive `.tex`, collisions remain visible for correction, and pending/server errors stay in the draft.
- Rename now edits the complete file or folder name, including the extension, and exposes explicit Save/Cancel actions. Moving focus no longer silently commits a rename.
- File and folder deletion uses an icon-free LocalLeaf alert dialog instead of native browser prompts. It names the target and type, gives Cancel initial focus, traps/restores focus, supports Escape and overlay cancellation, locks controls while pending, keeps host errors in-dialog, and reserves semantic red for the destructive action. Light/dark, reduced-motion, and forced-colors states are covered.
- The architecture audit confirmed that collaboration remains whole-file, last-arrival-wins. LocalLeaf now supports the host plus five separate guest slots, but conflict-safe simultaneous editing still requires per-document revisions/operations, reconnect recovery, exact-revision compile snapshots, atomic disk writes, and bounded host-side AI admission.
- Compiler diagnostics should become a structured Problems-first surface. Raw compiler attempts should be collapsed host-only troubleshooting output, and full raw logs should not be attached to ordinary AI prompts.

Verification for this follow-up: direct `node --test --test-concurrency=4` across every top-level test file passed 233/233 tests. `PMG_DISABLE_TELEMETRY=true pmg npm run test:rendered` passed the complete Electron gate, including transactional create/rename, delete cancel/pending/error/success, theme parity, PDF rendering/retry, SyncTeX navigation, and renderer health. JavaScript syntax checks pass.

Integrated verification: `PMG_DISABLE_TELEMETRY=true pmg npm test` rebuilt all browser bundles and passed 233/233 tests with zero failures/skips. `PMG_DISABLE_TELEMETRY=true pmg npm run test:rendered` completed successfully across Home, Project, Session, Editor, Settings, Help, About, and menus in light/dark themes at 1024×640 and 1440×900, including route/dialog/sidebar motion, reduced motion, forced colors, PDF render/retry, source mapping, the in-place Settings disclosure, and custom-provider focus/scroll checks. JavaScript syntax and scoped `git diff --check` pass.

### 2026-07-13 guest access, Chat actions, disclosure motion, and expanding search

- Live sessions now treat the host separately from five guest slots. Public guest roles are intentionally limited to **Viewer** and **Maintainer**: Viewers can read source files and PDFs and participate in project chat; Maintainers can also edit project files and use host-mediated AI. Compilation remains host-only.
- Host Session is the authoritative guest-management surface. Pending requests default to Viewer, role changes take effect on active HTTP/WebSocket clients without reconnecting, and confirmed removal invalidates the guest token, closes live transports, clears that guest's temporary AI state, and frees the slot immediately.
- Chat has compact host-only Share and Manage guests actions. Manage guests navigates to Host Session and focuses the guest manager; the host is shown separately and connected/pending guests have row-level busy, error, role, and removal states.
- Viewer lock-down is enforced on both server and client. CodeMirror and project-mutation controls are read-only, dynamically rebuilt Search/Replace controls inherit the lock, file switching remains available without attempting a save, and a live downgrade discards pending local saves before restoring the authoritative host source.
- The editor search launcher keeps a 56px resting footprint and reveals a 230px field into reserved toolbar space using transform/opacity rather than animating layout width. Enter opens/runs full search, Escape collapses and restores editor focus, and quick/full queries stay synchronized.
- Help, provider Advanced context, Settings model groups, editor text-style menus, and Host Session provider controls use restrained disclosure motion, 18px chevrons, keyboard/focus handling, and exact reduced-motion and forced-colors fallbacks. Menus that float use transform/opacity; content sections use bounded height/opacity transitions.

Integrated verification for this follow-up: direct `node --test --test-concurrency=4` across every top-level test file passes 238/238 with zero failures, skips, or cancellations. The security gate includes deterministic slow-body file/AI downgrade races, fail-closed Viewer-default approval, SSE revocation and termination, WebSocket close code `4003`, and revoked-token reconnect rejection. `PMG_DISABLE_TELEMETRY=true pmg npm run test:rendered` completes successfully across both desktop themes and supported viewport sizes, including the 900px editor minimum, measured model disclosures, provider selection without a full render, style-menu keyboard focus, expanding search, Viewer multi-file access, dynamic Search/Replace lock-down, live role remounting, removal focus, removed-before-poll termination, PDF rendering/retry, SyncTeX navigation, and renderer health. JavaScript syntax and repository-wide `git diff --check` pass.

### 2026-07-13 v0.1.25 Help, About, and release preparation

- Help now contains nine native FAQ disclosures covering project storage and import, hosting, Viewer and Maintainer roles, whole-file collaboration limits, last-good PDF behavior, local and hosted AI privacy, proposal review, invite rotation, and backups. Opening and closing are keyboard-accessible, motion reverses cleanly, and the dialog owns its scroll at the 900px minimum desktop width.
- About remains icon-free. It explains the host-owned session model, six product details, automatic versus reviewed AI edits, the host-online requirement, same-file last-arrival-wins behavior, and the intended research-group and classmate audience.
- Invite-link guidance now distinguishes approval from connectivity: refreshing preserves existing approvals, but a connected guest may need the replacement link to reconnect.
- The FAQ and About surfaces use flat editorial dividers, one restrained orange action, dark/light parity, reduced-motion and forced-colors fallbacks, and no outer page scrolling at 900x640, 1024x640, or 1440x900.
- Release metadata, README copy, and the landing download note are aligned on `0.1.25`. Development-only skills, audit notes, concepts, and unreferenced logo experiments remain outside the product release scope.

Release validation: `PMG_DISABLE_TELEMETRY=true pmg npm test` rebuilt the browser clients and passed 238/238 tests. The rendered Electron gate passed after adding Help close/reversal and 900x640 Help/About containment coverage. Its rail-motion assertion explicitly emulates normal motion so Windows runner accessibility defaults cannot contradict the separate reduced-motion checks. Changed JavaScript syntax, JSON manifests, and repository-wide `git diff --check` pass. `PMG_DISABLE_TELEMETRY=true pmg npm run package:win` produced `LocalLeaf Host Setup 0.1.25.exe`; the packaged ASAR reports version `0.1.25`, contains the final FAQ/About copy, and remained responsive during the unpacked launch smoke. The local npm 11.8 dependency collector still reports the documented npm 11.16 floor warnings; the canonical tag workflows use Node 24.18.0/npm 11.16.0 and fresh lockfile installs.
