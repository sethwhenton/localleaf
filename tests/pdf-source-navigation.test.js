const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPdfOutputNavigationController,
  createPdfSourceNavigationController,
  isPdfHyperlinkTarget,
  revealPdfSourceFile
} = require("../public/pdf-source-navigation");

test("AI Review PDF navigation ignores an older lookup that finishes after the latest Review", async () => {
  const pending = [];
  const reveals = [];
  const statuses = [];
  const controller = createPdfOutputNavigationController({
    lookup: (target) => new Promise((resolve) => pending.push({ target, resolve })),
    reveal: async (output) => {
      reveals.push(output.page);
      return true;
    },
    onStatus: (status) => statuses.push(status.state)
  });

  const first = controller.navigate({ path: "main.tex", line: 4 });
  const second = controller.navigate({ path: "chapters/results.tex", line: 18 });
  pending[1].resolve({ ok: true, page: 2, x: 120, y: 240 });
  await second;
  pending[0].resolve({ ok: true, page: 1, x: 80, y: 160 });
  const olderResult = await first;

  assert.deepEqual(reveals, [2]);
  assert.equal(olderResult.superseded, true);
  assert.deepEqual(statuses, ["locating", "locating", "ready"]);
});

test("AI Review PDF navigation preserves unavailable forward-lookup states without revealing a page", async () => {
  for (const state of ["pending", "stale", "unavailable"]) {
    const statuses = [];
    let reveals = 0;
    const controller = createPdfOutputNavigationController({
      lookup: async () => ({
        ok: false,
        state,
        retryable: state !== "unavailable",
        recompileRequired: state === "stale",
        reason: `${state} result`
      }),
      reveal: async () => {
        reveals += 1;
        return true;
      },
      onStatus: (status) => statuses.push(status)
    });

    const result = await controller.navigate({ path: "main.tex", line: 8 });

    assert.equal(result.state, state);
    assert.equal(result.retryable, state !== "unavailable");
    assert.equal(result.recompileRequired, state === "stale");
    assert.equal(reveals, 0);
    assert.deepEqual(statuses.map((status) => status.state), ["locating", state]);
  }
});

test("PDF source navigation remains isolated between participant clients", async () => {
  const hostReveals = [];
  const guestReveals = [];
  const host = createPdfSourceNavigationController({
    lookup: async () => ({ ok: true, path: "host-notes.tex", line: 8, column: 2 }),
    reveal: async (source) => hostReveals.push(source)
  });
  const guest = createPdfSourceNavigationController({
    lookup: async () => ({ ok: true, path: "chapters/guest.tex", line: 21, column: 0 }),
    reveal: async (source) => guestReveals.push(source)
  });

  await Promise.all([
    host.navigate({ page: 1, x: 10, y: 15 }),
    guest.navigate({ page: 2, x: 30, y: 35 })
  ]);

  assert.deepEqual(hostReveals.map((source) => source.path), ["host-notes.tex"]);
  assert.deepEqual(guestReveals.map((source) => source.path), ["chapters/guest.tex"]);
});

test("PDF source navigation ignores an older lookup that finishes after the latest click", async () => {
  const pending = [];
  const reveals = [];
  const controller = createPdfSourceNavigationController({
    lookup: (target) => new Promise((resolve) => pending.push({ target, resolve })),
    reveal: async (source) => reveals.push(source.path)
  });

  const first = controller.navigate({ page: 1, x: 10, y: 15 });
  const second = controller.navigate({ page: 1, x: 40, y: 45 });
  pending[1].resolve({ ok: true, path: "latest.tex", line: 9, column: 0 });
  await second;
  pending[0].resolve({ ok: true, path: "older.tex", line: 3, column: 0 });
  const olderResult = await first;

  assert.deepEqual(reveals, ["latest.tex"]);
  assert.equal(olderResult.superseded, true);
});

test("PDF source navigation reports pending and unavailable lookups without moving the editor", async () => {
  const statuses = [];
  let revealCount = 0;
  const controller = createPdfSourceNavigationController({
    lookup: async () => ({
      ok: false,
      state: "pending",
      retryable: true,
      reason: "The first PDF is still compiling."
    }),
    reveal: async () => {
      revealCount += 1;
    },
    onStatus: (status) => statuses.push(status)
  });

  const result = await controller.navigate({ page: 1, x: 1, y: 1 });

  assert.equal(result.state, "pending");
  assert.equal(revealCount, 0);
  assert.deepEqual(statuses.map((status) => status.state), ["mapping", "pending"]);
});

test("PDF source navigation fails visibly when the mapped file cannot be revealed", async () => {
  const statuses = [];
  const controller = createPdfSourceNavigationController({
    lookup: async () => ({ ok: true, path: "chapters/missing.tex", line: 14, column: 3 }),
    reveal: async () => false,
    onStatus: (status) => statuses.push(status)
  });

  const result = await controller.navigate({ page: 2, x: 24, y: 36 });

  assert.equal(result.ok, false);
  assert.equal(result.state, "unavailable");
  assert.match(result.reason, /open the mapped source/i);
  assert.deepEqual(statuses.map((status) => status.state), ["mapping", "unavailable"]);
});

test("PDF source reveal succeeds only when the exact mapped file is active after loading", async () => {
  let activePath = "main.tex";
  const source = { ok: true, path: "chapters/results.tex", line: 22, column: 1 };

  const refused = await revealPdfSourceFile(source, {
    selectFile: async () => false,
    selectedPath: () => activePath
  });
  const wrongFile = await revealPdfSourceFile(source, {
    selectFile: async () => true,
    selectedPath: () => activePath
  });

  assert.equal(refused, false);
  assert.equal(wrongFile, false);
  assert.equal(activePath, "main.tex");
});

test("PDF source navigation leaves rendered hyperlink clicks to the PDF link layer", () => {
  let receivedSelector = "";
  const link = { href: "https://example.com" };
  const target = {
    closest(selector) {
      receivedSelector = selector;
      return link;
    }
  };

  assert.equal(isPdfHyperlinkTarget(target), true);
  assert.match(receivedSelector, /a\[href\]/);
  assert.equal(isPdfHyperlinkTarget({ closest: () => null }), false);
  assert.equal(isPdfHyperlinkTarget(null), false);
});
