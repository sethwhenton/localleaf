const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCompilerArguments,
  buildCompilerEnvironment,
  capCompilerLogs,
  cleanupCompileArtifact,
  compileProject,
  detectCompiler,
  expectedPdfPath,
  expectedSynctexPath,
  findProjectLatexmkConfig,
  normalizeProcessExitCode,
  readIncludedFiles,
  runProcess
} = require("../src/server/compiler");

test("resolves PDF and SyncTeX artifact names case-insensitively for uppercase TEX files", () => {
  const outputDir = path.join(os.tmpdir(), "localleaf-uppercase-output");
  assert.equal(expectedPdfPath("C:\\project", "REPORT.TEX", outputDir), path.join(outputDir, "REPORT.pdf"));
  assert.equal(expectedSynctexPath("C:\\project", "REPORT.TEX", outputDir), path.join(outputDir, "REPORT.synctex.gz"));
});

test("reads included LaTeX sources regardless of extension casing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-uppercase-include-"));
  try {
    fs.writeFileSync(path.join(root, "MAIN.TEX"), "\\input{CHAPTER}", "utf8");
    fs.writeFileSync(path.join(root, "CHAPTER.TeX"), "Included chapter", "utf8");
    const included = readIncludedFiles(root);
    assert.equal(included.get("MAIN.TEX"), "\\input{CHAPTER}");
    assert.equal(included.get("CHAPTER.TeX"), "Included chapter");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("never treats a timed-out or signal-terminated compiler process as success", () => {
  assert.equal(normalizeProcessExitCode({ code: null, timedOut: true }), 124);
  assert.equal(normalizeProcessExitCode({ code: null, outputLimitExceeded: true }), 125);
  assert.equal(normalizeProcessExitCode({ code: null, signal: "SIGKILL" }), 1);
  assert.equal(normalizeProcessExitCode({ code: 0, timedOut: false }), 0);
});

test("stops a compiler process that exceeds the output budget", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024)); setInterval(() => {}, 1000);"],
    {
      cwd: os.tmpdir(),
      timeoutMs: 5000,
      maxOutputBytes: 32 * 1024
    }
  );

  assert.equal(result.outputLimitExceeded, true);
  assert.equal(normalizeProcessExitCode(result), 125);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 32 * 1024);
  assert.match(result.output, /safe limit/i);
});

test("bounds aggregate compiler logs while preserving the newest diagnostics", () => {
  const logs = Array.from({ length: 3000 }, (_, index) => `diagnostic-${index}-${"x".repeat(40)}`);
  const capped = capCompilerLogs(logs, { maxBytes: 4096, maxLines: 25 });

  assert.match(capped[0], /truncated/i);
  assert.ok(capped.length <= 26);
  assert.equal(capped.at(-1), logs.at(-1));
  assert.ok(Buffer.byteLength(`${capped.join("\n")}\n`, "utf8") <= 4096);
});

test("detects hidden project latexmk configuration before running latexmk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-hidden-latexmkrc-"));
  try {
    fs.writeFileSync(path.join(root, ".latexmkrc"), "die 'must not execute';", "utf8");
    assert.equal(findProjectLatexmkConfig(root), path.join(root, ".latexmkrc"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("latexmk explicitly disables shell escape", () => {
  assert.deepEqual(buildCompilerArguments("latexmk", {
    mainFile: "main.tex",
    outputDir: "/tmp/localleaf-output"
  }), [
    "-pdf",
    "-outdir=/tmp/localleaf-output",
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    "-latexoption=-no-shell-escape",
    "main.tex"
  ]);
});

test("Tectonic compiles untrusted input with insecure features disabled", () => {
  assert.deepEqual(buildCompilerArguments("tectonic", {
    mainFile: "main.tex",
    outputDir: "/tmp/localleaf-output"
  }), [
    "--untrusted",
    "--synctex",
    "--outdir",
    "/tmp/localleaf-output",
    "main.tex"
  ]);
});

test("direct LaTeX engines explicitly disable shell escape", () => {
  assert.deepEqual(buildCompilerArguments("pdflatex", {
    mainFile: "main.tex",
    outputDir: "/tmp/localleaf-output"
  }), [
    "-no-shell-escape",
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    "-output-directory=/tmp/localleaf-output",
    "main.tex"
  ]);
});

test("compiler processes receive runtime paths without inherited application secrets", () => {
  const sourceEnvironment = {
    Path: "C:\\TeX\\bin",
    PATHEXT: ".EXE;.CMD",
    SystemRoot: "C:\\Windows",
    HOME: "/home/localleaf",
    TMP: "/tmp/localleaf",
    LANG: "en_US.UTF-8",
    TEXMFCNF: "/opt/texlive/texmf-dist/web2c",
    FONTCONFIG_PATH: "/etc/fonts",
    AWS_SECRET_ACCESS_KEY: "must-not-reach-tex",
    LOCALLEAF_HOST_TOKEN: "must-not-reach-tex",
    NODE_OPTIONS: "--require ./unexpected.js"
  };

  assert.deepEqual(buildCompilerEnvironment(sourceEnvironment), {
    Path: "C:\\TeX\\bin",
    PATHEXT: ".EXE;.CMD",
    SystemRoot: "C:\\Windows",
    HOME: "/home/localleaf",
    TMP: "/tmp/localleaf",
    LANG: "en_US.UTF-8",
    TEXMFCNF: "/opt/texlive/texmf-dist/web2c",
    FONTCONFIG_PATH: "/etc/fonts"
  });
});

test("keeps the last successful PDF visible after a failed compile", { skip: !detectCompiler().available }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-test-"));
  let publishedPdfPath = null;

  try {
    fs.writeFileSync(
      path.join(root, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nStable preview\n\\end{document}\n",
      "utf8"
    );

    const first = await compileProject(root, "main.tex");
    publishedPdfPath = first.pdfPath;
    assert.equal(first.ok, true);
    assert.equal(first.mode, "pdf");
    assert.equal(fs.existsSync(first.pdfPath), true);
    const firstPdfSize = fs.statSync(first.pdfPath).size;
    assert.ok(firstPdfSize > 0);

    fs.writeFileSync(
      path.join(root, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nThis compile is missing its document end.\n",
      "utf8"
    );

    const second = await compileProject(root, "main.tex", undefined, { previousPdfPath: first.pdfPath });
    assert.equal(second.ok, false);
    assert.equal(second.mode, "pdf");
    assert.equal(second.pdfPath, first.pdfPath);
    assert.equal(fs.existsSync(second.pdfPath), true);
    assert.equal(fs.statSync(second.pdfPath).size, firstPdfSize);
    assert.ok(second.logs.some((line) => line.includes("Keeping the last successful PDF preview visible")));
  } finally {
    cleanupCompileArtifact(publishedPdfPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
