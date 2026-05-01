const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compileProject, detectCompiler } = require("../src/server/compiler");

test("keeps the last successful PDF visible after a failed compile", { skip: !detectCompiler().available }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-test-"));
  const pdfPath = path.join(root, "main.pdf");

  try {
    fs.writeFileSync(
      path.join(root, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nStable preview\n\\end{document}\n",
      "utf8"
    );

    const first = await compileProject(root, "main.tex");
    assert.equal(first.ok, true);
    assert.equal(first.mode, "pdf");
    assert.equal(fs.existsSync(pdfPath), true);
    const firstPdfSize = fs.statSync(pdfPath).size;
    assert.ok(firstPdfSize > 0);

    fs.writeFileSync(
      path.join(root, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nThis compile is missing its document end.\n",
      "utf8"
    );

    const second = await compileProject(root, "main.tex");
    assert.equal(second.ok, false);
    assert.equal(second.mode, "pdf");
    assert.equal(fs.existsSync(pdfPath), true);
    assert.equal(fs.statSync(pdfPath).size, firstPdfSize);
    assert.ok(second.logs.some((line) => line.includes("Keeping the last successful PDF preview visible")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
