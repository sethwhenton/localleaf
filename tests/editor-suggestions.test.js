const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectProjectEditorSuggestions } = require("../src/server/editor-suggestions");
const { listProjectFiles } = require("../src/server/safe-path");

test("collects project-aware LaTeX editor suggestions", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-suggestions-"));
  try {
    fs.writeFileSync(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\usepackage{amsmath,graphicx}",
        "\\newcommand{\\vect}[1]{\\mathbf{#1}}",
        "\\DeclareMathOperator{\\argmax}{argmax}",
        "\\newenvironment{solution}{\\par}{\\par}",
        "\\begin{document}",
        "\\section{Intro}\\label{sec:intro}",
        "\\begin{equation}\\label{eq:model} x = 1 \\end{equation}",
        "\\cite{smith2024}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectRoot, "refs.bib"),
      "@article{smith2024, title={Example}}\n@inproceedings{doe2025, title={Next}}",
      "utf8"
    );

    const suggestions = collectProjectEditorSuggestions(projectRoot, listProjectFiles(projectRoot));
    assert.deepEqual(suggestions.labels, ["eq:model", "sec:intro"]);
    assert.deepEqual(suggestions.citations, ["doe2025", "smith2024"]);
    assert.deepEqual(suggestions.macros, ["argmax", "vect"]);
    assert.deepEqual(suggestions.environments, ["solution"]);
    assert.deepEqual(suggestions.packages, ["amsmath", "graphicx"]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
