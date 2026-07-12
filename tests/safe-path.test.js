const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  detectMainFile,
  normalizeRelativePath,
  resolveProjectPath
} = require("../src/server/safe-path");

test("detects a main LaTeX document with an uppercase TEX extension", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-uppercase-main-"));
  try {
    fs.writeFileSync(path.join(root, "MAIN.TEX"), "\\documentclass{article}\\begin{document}Hi\\end{document}", "utf8");
    assert.equal(detectMainFile(root), "MAIN.TEX");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes safe relative paths", () => {
  assert.equal(normalizeRelativePath("chapters\\intro.tex"), "chapters/intro.tex");
  assert.equal(normalizeRelativePath("/main.tex"), "main.tex");
});

test("rejects traversal and absolute paths", () => {
  assert.throws(() => normalizeRelativePath("../secret.txt"), /traversal/i);
  assert.throws(() => normalizeRelativePath("chapter/../secret.txt"), /traversal/i);
  assert.throws(() => normalizeRelativePath("C:/secret.txt"), /Absolute|traversal|outside/i);
});

test("rejects filenames that are unsafe on Windows", () => {
  for (const invalidPath of [
    "main.tex:hidden.txt",
    "auxiliary?.tex",
    "chapter<draft>.tex",
    "notes|final.tex",
    "folder/trailing-space ",
    "folder/trailing-dot."
  ]) {
    assert.throws(
      () => normalizeRelativePath(invalidPath),
      /Windows|filename|invalid/i,
      invalidPath
    );
  }
});

test("resolves paths inside the project root", () => {
  const root = path.resolve(__dirname, "../samples/thesis");
  const resolved = resolveProjectPath(root, "main.tex");
  assert.equal(resolved, path.join(root, "main.tex"));
});
