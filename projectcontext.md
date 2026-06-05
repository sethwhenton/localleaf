# LocalLeaf Project Context

Last updated: 2026-06-05.

## Project Summary

LocalLeaf is a host-powered Overleaf-style collaboration app. The host installs and runs a local Electron/Node desktop app, opens a browser-based LaTeX editor, compiles PDFs locally, and can share a temporary collaboration link through a tunnel. Guests join from a browser and do not need the desktop app.

The repository is a single npm project:

- App name and version: `localleaf` `0.1.22`
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
- The AI Helper chat renders approval cards. The Changes tab is history/review only with view, explain, copy diff, and open file actions.
- AI Helper permission settings are stored client-side and sent with each AI request. They currently control hosted-provider routing, rewrite requests, ask-before-edit approval cards, YOLO/no-confirm auto-apply for safe text proposals, multi-file intent, and advanced request gates for file management, uploads/imports, shell commands, and binary files.
- The AI Helper timeline auto-scrolls to the latest message for active sessions and shows a floating jump-to-latest arrow when the user scrolls up. The composer has a compact session strip for steering, deleting/renaming sessions, queueing follow-up prompts, and toggling between Default permissions and YOLO mode.
- Advanced actions are still host-gated. When enabled, those requests can reach the active model; the deterministic local fallback only automates safe text proposals and otherwise returns an acknowledgement rather than executing shell/file-management operations directly.
- Cursor remains a provider template, but `@cursor/sdk` is intentionally not bundled in `0.1.18` because the current npm package pulls vulnerable transitive dependencies. Use LocalLeaf Local or an OpenAI-compatible provider for the release build.
- The AI Helper now sends recent conversation context and project-wide LaTeX context, so include files such as `includes/abstract.tex` can be edited even when another file is open.
- Search/replace supports current-file and all-file search, and project-wide Replace All is host-side through `/api/search/replace`.
- Settings and About surfaces were polished with the Ollama GetDesign reference as a layout/style guide while keeping LocalLeaf's orange, white, and dark palettes.
- LocalLeaf Local starts bundled llama.cpp with a 16k context by default and uses a smaller local-only AI prompt budget, so large projects do not exceed the default 4k model context. `LOCALLEAF_LOCAL_CONTEXT_SIZE` can override the runtime context size between 4096 and 32768.
- Release binary preparation now downloads pinned GitHub release asset URLs directly and verifies SHA-256, avoiding GitHub Releases API rate-limit failures in CI.
- Version `0.1.22` is an upload reliability release: image/PDF uploads now normalize Windows/macOS paths, save raw bytes, appear immediately in the Images panel, and are covered by server-flow regression tests.

Current focused verification after the AI Helper harness work:

```powershell
node --check public\app.js src\server\index.js src\server\ai-models.js
node --test tests\ai-agent.test.js tests\ai-providers.test.js
```

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
- CI installs dependencies with `npm ci --ignore-scripts`.
- CI explicitly rebuilds only the known required install-script packages:
  - macOS: `electron`, `esbuild`
  - Windows: `electron`, `esbuild`, `electron-winstaller`
- Release workflows verify npm is at least `11.10.0`, because `min-release-age` requires npm v11 support.

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
