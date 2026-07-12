const test = require("node:test");
const assert = require("node:assert/strict");

test("times out and retries a stalled PDF response", async () => {
  const { fetchPdfBytes } = await import("../src/client/pdf-fetch.mjs");
  let attempts = 0;
  const stalledFetch = (_url, options = {}) => {
    attempts += 1;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };

  await assert.rejects(
    fetchPdfBytes("/api/pdf", {
      fetchImpl: stalledFetch,
      retryDelays: [1],
      timeoutMs: 100
    }),
    /timed out/i
  );
  assert.equal(attempts, 2);
});

test("retries a transient response and returns PDF bytes", async () => {
  const { fetchPdfBytes } = await import("../src/client/pdf-fetch.mjs");
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([37, 80, 68, 70]).buffer
    };
  };

  const bytes = await fetchPdfBytes("/api/pdf", { fetchImpl, retryDelays: [1], timeoutMs: 100 });
  assert.deepEqual([...bytes], [37, 80, 68, 70]);
  assert.equal(attempts, 2);
});

test("honors caller cancellation without retrying", async () => {
  const { fetchPdfBytes } = await import("../src/client/pdf-fetch.mjs");
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  await assert.rejects(
    fetchPdfBytes("/api/pdf", {
      signal: controller.signal,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      retryDelays: [1],
      timeoutMs: 100
    }),
    (error) => error?.name === "AbortError"
  );
  assert.equal(attempts, 0);
});

test("does not retry a non-retryable HTTP response", async () => {
  const { fetchPdfBytes } = await import("../src/client/pdf-fetch.mjs");
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
  };

  await assert.rejects(
    fetchPdfBytes("/api/pdf", {
      fetchImpl,
      retryDelays: [0, 0],
      timeoutMs: 100
    }),
    (error) => error?.status === 403
  );
  assert.equal(attempts, 1);
});
