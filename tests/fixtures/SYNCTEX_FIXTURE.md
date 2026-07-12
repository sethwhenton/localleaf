# Tectonic SyncTeX fixture

`synctex-tectonic-minimal.synctex` was produced by the bundled Tectonic 0.16.9 binary from `synctex-tectonic-minimal.tex` with:

```text
tectonic --only-cached --untrusted --synctex --outdir <temp> tests/fixtures/synctex-tectonic-minimal.tex
```

Only the absolute `Input:1:` prefix was removed so the fixture is portable. The bundled JavaScript reader and MiKTeX SyncTeX CLI 1.5 both resolve these PDF-point coordinates identically:

- page 1, x 150, y 132 -> line 3 (`First line.`)
- page 1, x 150, y 143 -> line 5 (`Second target line.`)

The fixture retains Tectonic's `Magnification:1000`, `Unit:1`, and zero X/Y offsets.
