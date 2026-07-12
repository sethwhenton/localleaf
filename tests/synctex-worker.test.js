const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { createSynctexWorkerClient } = require("../src/server/synctex-worker-client");

function fixtureGzip() {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  return zlib.gzipSync(fixture);
}

function writeAtMtime(filePath, contents, mtime) {
  fs.writeFileSync(filePath, contents);
  fs.utimesSync(filePath, mtime, mtime);
}

function largeSynctexGzip(recordCount = 300_000) {
  const records = new Array(recordCount).fill("h1,3:9830400,8650752:6578176");
  const source = [
    "SyncTeX Version:1",
    "Input:1:main.tex",
    "Output:pdf",
    "Magnification:1000",
    "Unit:1",
    "X Offset:0",
    "Y Offset:0",
    "Content:",
    "{1",
    "[1,1:9830400,8650752:6578176,657817,0",
    "(1,3:9830400,8650752:6578176,657817,0",
    ...records,
    ")",
    "]",
    "}1",
    "Postamble:"
  ].join("\n");
  return zlib.gzipSync(Buffer.from(source, "utf8"));
}

test("the worker-backed reader matches real Tectonic reverse-search coordinates", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-worker-fixture-"));
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(synctexPath, fixtureGzip());
  const client = createSynctexWorkerClient({ timeoutMs: 5_000 });

  try {
    assert.deepEqual(
      await client.lookup({ synctexPath, page: 1, x: 150, y: 132 }),
      { ok: true, path: "synctex-tectonic-minimal.tex", line: 3, column: 0 }
    );
    assert.deepEqual(
      await client.lookup({ synctexPath, page: 1, x: 150, y: 143 }),
      { ok: true, path: "synctex-tectonic-minimal.tex", line: 5, column: 0 }
    );
  } finally {
    await client.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the worker exposes a separately sanitized forward source lookup for packaged builds", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-worker-forward-"));
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(synctexPath, fixtureGzip());
  const client = createSynctexWorkerClient({ timeoutMs: 5_000 });

  try {
    const mapped = await client.lookupSource({
      synctexPath,
      sourcePath: path.join(tempRoot, "synctex-tectonic-minimal.tex"),
      relativePath: "synctex-tectonic-minimal.tex",
      line: 5,
      column: 0
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.page, 1);
    assert.ok(mapped.x > 0);
    assert.ok(mapped.y > 0);
    assert.ok(mapped.width > 0);
    assert.ok(mapped.height > 0);
    assert.equal(Object.hasOwn(mapped, "path"), false);

    const unmapped = await client.lookupSource({
      synctexPath,
      relativePath: "missing.tex",
      line: 5,
      column: 0
    });
    assert.equal(unmapped.ok, false);
    assert.equal(unmapped.code, "UNMAPPED");

    assert.deepEqual(
      await client.lookup({ synctexPath, page: 1, x: 150, y: 132 }),
      { ok: true, path: "synctex-tectonic-minimal.tex", line: 3, column: 0 }
    );
  } finally {
    await client.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the worker cache invalidates changed artifacts and retains only one artifact", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-worker-cache-"));
  const firstPath = path.join(tempRoot, "first.synctex.gz");
  const secondPath = path.join(tempRoot, "second.synctex.gz");
  const valid = fixtureGzip();
  const invalidSameSize = Buffer.alloc(valid.length, 0);
  const fixedMtime = new Date("2025-01-02T03:04:05.000Z");
  writeAtMtime(firstPath, valid, fixedMtime);
  writeAtMtime(secondPath, valid, new Date("2025-01-02T03:04:06.000Z"));
  const client = createSynctexWorkerClient({ timeoutMs: 5_000 });

  try {
    const input = { synctexPath: firstPath, page: 1, x: 150, y: 132 };
    assert.equal((await client.lookup(input)).line, 3);

    // An identical path/size/mtime is the cache key, so this deliberately
    // colliding rewrite remains a hit until another artifact replaces it.
    writeAtMtime(firstPath, invalidSameSize, fixedMtime);
    assert.equal((await client.lookup(input)).line, 3);

    assert.equal((await client.lookup({ ...input, synctexPath: secondPath })).line, 3);
    const afterEviction = await client.lookup(input);
    assert.equal(afterEviction.ok, false);
    assert.equal(afterEviction.code, "INVALID_GZIP");

    writeAtMtime(firstPath, valid, new Date("2025-01-02T03:04:07.000Z"));
    assert.equal((await client.lookup(input)).line, 3);
  } finally {
    await client.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a timed-out worker is replaced and the next lookup succeeds", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-worker-timeout-"));
  const slowPath = path.join(tempRoot, "slow.synctex.gz");
  const fixturePath = path.join(tempRoot, "fixture.synctex.gz");
  fs.writeFileSync(slowPath, largeSynctexGzip(120_000));
  fs.writeFileSync(fixturePath, fixtureGzip());
  const client = createSynctexWorkerClient({ timeoutMs: 5_000 });

  try {
    const timedOut = await client.lookup(
      { synctexPath: slowPath, page: 1, x: 150, y: 132 },
      { workerTimeoutMs: 25 }
    );
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.code, "WORKER_TIMEOUT");

    assert.deepEqual(
      await client.lookup({ synctexPath: fixturePath, page: 1, x: 150, y: 132 }),
      { ok: true, path: "synctex-tectonic-minimal.tex", line: 3, column: 0 }
    );
  } finally {
    await client.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("large JavaScript SyncTeX parsing leaves the main event loop responsive", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-worker-responsive-"));
  const synctexPath = path.join(tempRoot, "large.synctex.gz");
  fs.writeFileSync(synctexPath, largeSynctexGzip());
  const client = createSynctexWorkerClient({ timeoutMs: 10_000 });
  let interval;

  try {
    let tickCount = 0;
    const fiveMainLoopTicks = new Promise((resolve) => {
      interval = setInterval(() => {
        tickCount += 1;
        if (tickCount >= 5) resolve({ completed: "ticks" });
      }, 10);
    });
    const lookup = client.lookup({ synctexPath, page: 1, x: 150, y: 132 }).then((result) => ({
      completed: "lookup",
      result
    }));
    const firstCompletion = await Promise.race([fiveMainLoopTicks, lookup]);
    assert.equal(firstCompletion.completed, "ticks", "the main loop should keep running while the worker parses");

    const { result } = await lookup;
    clearInterval(interval);
    interval = null;

    assert.deepEqual(result, { ok: true, path: "main.tex", line: 3, column: 0 });
  } finally {
    if (interval) clearInterval(interval);
    await client.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
