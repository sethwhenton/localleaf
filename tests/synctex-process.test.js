const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { runBoundedChildProcess } = require("../src/server/index");

test("bounded child processes time out without blocking the Node event loop", async () => {
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 10);
  const startedAt = Date.now();
  const result = await runBoundedChildProcess(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)"
  ], {
    cwd: process.cwd(),
    timeoutMs: 80,
    maxOutputBytes: 4096
  });
  clearTimeout(timer);

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(timerFired, true);
  assert.ok(Date.now() - startedAt < 1000);
});

test("bounded child processes return deterministic spawn errors", async () => {
  const result = await runBoundedChildProcess(
    `localleaf-missing-synctex-${process.pid}-${Date.now()}`,
    ["edit"],
    { cwd: process.cwd(), timeoutMs: 200, maxOutputBytes: 4096 }
  );

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnFailed, true);
  assert.equal(typeof result.errorCode, "string");
});

test("a timed-out SyncTeX process keeps its lookup slot until the child closes", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    setTimeout(() => child.emit("close", null, "SIGKILL"), 70);
    return true;
  };
  let settled = false;
  const resultPromise = runBoundedChildProcess("fake-synctex", ["edit"], {
    cwd: process.cwd(),
    timeoutMs: 25,
    killGraceMs: 250,
    maxOutputBytes: 4096,
    spawnImpl: () => child
  }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.equal(settled, false);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(killCalls, 1);
});

test("a SyncTeX process over the output limit stays active until the child closes", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    setTimeout(() => child.emit("close", null, "SIGKILL"), 60);
    return true;
  };
  let settled = false;
  const resultPromise = runBoundedChildProcess("fake-synctex", ["edit"], {
    cwd: process.cwd(),
    timeoutMs: 500,
    killGraceMs: 250,
    maxOutputBytes: 1024,
    spawnImpl: () => child
  }).then((result) => {
    settled = true;
    return result;
  });
  child.stdout.write(Buffer.alloc(2048, "x"));

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdout.length, 1024);
});

test("bounded SyncTeX termination has a kill-grace fallback when close never arrives", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    return true;
  };

  const startedAt = Date.now();
  const result = await runBoundedChildProcess("fake-synctex", ["edit"], {
    cwd: process.cwd(),
    timeoutMs: 25,
    killGraceMs: 40,
    maxOutputBytes: 4096,
    spawnImpl: () => child
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.killGraceExpired, true);
  assert.equal(killCalls, 2);
  assert.ok(Date.now() - startedAt < 500);
});
