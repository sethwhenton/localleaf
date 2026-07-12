const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  resolveSynctexOutputPosition,
  resolveSynctexPosition
} = require("../src/server/synctex-js");

test("the bundled reader matches Tectonic reverse-search coordinates from a real SyncTeX fixture", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-tectonic-fixture-"));
  const synctexPath = path.join(tempRoot, "synctex-tectonic-minimal.synctex.gz");
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  fs.writeFileSync(synctexPath, zlib.gzipSync(fixture));

  try {
    const firstLine = await resolveSynctexPosition({ synctexPath, page: 1, x: 150, y: 132 });
    const secondLine = await resolveSynctexPosition({ synctexPath, page: 1, x: 150, y: 143 });
    assert.deepEqual(firstLine, {
      ok: true,
      path: "synctex-tectonic-minimal.tex",
      line: 3,
      column: 0
    });
    assert.deepEqual(secondLine, {
      ok: true,
      path: "synctex-tectonic-minimal.tex",
      line: 5,
      column: 0
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the bundled reader maps an exact source line forward to the real Tectonic PDF fixture", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-forward-fixture-"));
  const synctexPath = path.join(tempRoot, "synctex-tectonic-minimal.synctex.gz");
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  fs.writeFileSync(synctexPath, zlib.gzipSync(fixture));

  try {
    const mapped = await resolveSynctexOutputPosition({
      synctexPath,
      sourcePath: path.join(tempRoot, "synctex-tectonic-minimal.tex"),
      relativePath: "synctex-tectonic-minimal.tex",
      line: 5,
      column: 0
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.page, 1);
    assert.ok(Number.isFinite(mapped.x) && mapped.x > 0);
    assert.ok(Number.isFinite(mapped.y) && mapped.y > 0);
    assert.ok(mapped.width > 0);
    assert.ok(mapped.height > 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the bundled forward reader refuses unrelated files and distant lines", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-forward-miss-"));
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  fs.writeFileSync(synctexPath, zlib.gzipSync(fixture));

  try {
    const missingFile = await resolveSynctexOutputPosition({
      synctexPath,
      relativePath: "another/main.tex",
      line: 5,
      column: 0
    });
    const distantLine = await resolveSynctexOutputPosition({
      synctexPath,
      relativePath: "synctex-tectonic-minimal.tex",
      line: 200,
      column: 0
    });
    assert.equal(missingFile.code, "UNMAPPED");
    assert.equal(distantLine.code, "UNMAPPED");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the bundled SyncTeX reader rejects oversized compressed data before parsing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-compressed-limit-"));
  const synctexPath = path.join(tempRoot, "oversized.synctex.gz");
  fs.writeFileSync(synctexPath, Buffer.alloc(65, "x"));

  try {
    const result = await resolveSynctexPosition(
      { synctexPath, page: 1, x: 0, y: 0 },
      { maxCompressedBytes: 64 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "COMPRESSED_LIMIT");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the bundled SyncTeX reader bounds inflated gzip data", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-inflated-limit-"));
  const synctexPath = path.join(tempRoot, "inflate.synctex.gz");
  fs.writeFileSync(synctexPath, zlib.gzipSync(Buffer.alloc(4096, "x")));

  try {
    const result = await resolveSynctexPosition(
      { synctexPath, page: 1, x: 0, y: 0 },
      { maxCompressedBytes: 1024, maxInflatedBytes: 512 }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "INFLATED_LIMIT");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the bundled SyncTeX reader bounds parsed lines and source records", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-parse-limits-"));
  const synctexPath = path.join(tempRoot, "records.synctex.gz");
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  fs.writeFileSync(synctexPath, zlib.gzipSync(fixture));

  try {
    const lineLimited = await resolveSynctexPosition(
      { synctexPath, page: 1, x: 150, y: 132 },
      { maxLines: 2 }
    );
    const recordLimited = await resolveSynctexPosition(
      { synctexPath, page: 1, x: 150, y: 132 },
      { maxRecords: 1 }
    );
    assert.equal(lineLimited.code, "LINE_LIMIT");
    assert.equal(recordLimited.code, "RECORD_LIMIT");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
