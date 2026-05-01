# LaTeX Compiler Setup

LocalLeaf can edit and sync projects without a full TeX distribution. The Windows installer bundles Tectonic so fresh installs can compile PDF files without requiring students to install MiKTeX or TeX Live first.

Tectonic may download TeX support files the first time a project uses a package it has not cached yet. After those files are cached on the host computer, later compiles can reuse them.

## Bundled Compiler

The packaged app includes:

- `resources/bin/tectonic.exe` inside the installed app.
- Tectonic's license notice in `resources/bin/licenses`.

For development builds, run:

```powershell
npm.cmd run install:tectonic
```

This downloads the latest official Windows x64 Tectonic release from GitHub into:

```text
bin/tectonic.exe
```

## Compiler Order

LocalLeaf tries compilers in this order:

1. `latexmk`
2. bundled `tectonic.exe`
3. system `tectonic`
4. `pdflatex`
5. `xelatex`
6. `lualatex`

If `latexmk` fails and Tectonic is available, LocalLeaf tries Tectonic as a fallback. Direct engine compilation runs two passes and runs `bibtex` when a bibliography is detected and `bibtex` is available.

## Optional Full TeX Setup

Tectonic is the lightweight default. For maximum package compatibility, a host can still install MiKTeX or TeX Live. LocalLeaf will detect those tools from `PATH` and use them when available.
