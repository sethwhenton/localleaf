const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  normalizeRelativePath,
  resolveProjectPath
} = require("../src/server/safe-path");

test("normalizes safe relative paths", () => {
  assert.equal(normalizeRelativePath("chapters\\intro.tex"), "chapters/intro.tex");
  assert.equal(normalizeRelativePath("/main.tex"), "main.tex");
});

test("rejects traversal and absolute paths", () => {
  assert.throws(() => normalizeRelativePath("../secret.txt"), /traversal/i);
  assert.throws(() => normalizeRelativePath("chapter/../secret.txt"), /traversal/i);
  assert.throws(() => normalizeRelativePath("C:/secret.txt"), /Absolute|traversal|outside/i);
});

test("resolves paths inside the project root", () => {
  const root = path.resolve(__dirname, "../samples/thesis");
  const resolved = resolveProjectPath(root, "main.tex");
  assert.equal(resolved, path.join(root, "main.tex"));
});
