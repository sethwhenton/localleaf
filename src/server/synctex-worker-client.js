const path = require("node:path");
const { Worker } = require("node:worker_threads");

const DEFAULT_WORKER_TIMEOUT_MS = 2_500;
const MIN_WORKER_TIMEOUT_MS = 25;
const MAX_WORKER_TIMEOUT_MS = 30_000;
const MAX_RESULT_PATH_LENGTH = 4_096;
const LIMIT_KEYS = ["maxCompressedBytes", "maxInflatedBytes", "maxLines", "maxRecords"];

function boundedTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(MIN_WORKER_TIMEOUT_MS, Math.min(MAX_WORKER_TIMEOUT_MS, Math.round(number)));
}

function failure(code, reason) {
  return {
    ok: false,
    code,
    reason
  };
}

function sanitizeReverseResult(result) {
  if (!result || typeof result !== "object") {
    return failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX worker returned an invalid response.");
  }
  if (!result.ok) {
    return {
      ok: false,
      code: String(result.code || "SYNCTEX_PARSE_FAILED").slice(0, 64),
      reason: String(result.reason || "The bundled SyncTeX reader could not map this PDF.").slice(0, 240)
    };
  }
  const sourcePath = String(result.path || "");
  const line = Number(result.line);
  const column = Number(result.column || 0);
  if (
    !sourcePath
    || sourcePath.length > MAX_RESULT_PATH_LENGTH
    || !Number.isSafeInteger(line)
    || line < 1
    || !Number.isSafeInteger(column)
    || column < 0
  ) {
    return failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX worker returned an invalid response.");
  }
  return { ok: true, path: sourcePath, line, column };
}

function sanitizeForwardResult(result) {
  if (!result || typeof result !== "object") {
    return failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX worker returned an invalid response.");
  }
  if (!result.ok) {
    return {
      ok: false,
      code: String(result.code || "SYNCTEX_PARSE_FAILED").slice(0, 64),
      reason: String(
        result.reason || "The bundled SyncTeX reader could not map this source position to the PDF."
      ).slice(0, 240)
    };
  }
  const page = Number(result.page);
  const x = Number(result.x);
  const y = Number(result.y);
  const width = Number(result.width);
  const height = Number(result.height);
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || width < 0
    || !Number.isFinite(height)
    || height < 0
  ) {
    return failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX worker returned an invalid response.");
  }
  return { ok: true, page, x, y, width, height };
}

function sanitizedInput(input = {}) {
  return {
    synctexPath: String(input.synctexPath || ""),
    page: Number(input.page),
    x: Number(input.x),
    y: Number(input.y)
  };
}

function sanitizedForwardInput(input = {}) {
  return {
    synctexPath: String(input.synctexPath || ""),
    sourcePath: String(input.sourcePath || ""),
    relativePath: String(input.relativePath || ""),
    line: Number(input.line),
    column: Number(input.column || 0)
  };
}

function sanitizedLimits(options = {}) {
  const limits = {};
  for (const key of LIMIT_KEYS) {
    if (options[key] !== undefined) limits[key] = Number(options[key]);
  }
  return limits;
}

function createSynctexWorkerClient(options = {}) {
  const workerPath = path.resolve(options.workerPath || path.join(__dirname, "synctex-worker.js"));
  const defaultTimeoutMs = boundedTimeout(options.timeoutMs, DEFAULT_WORKER_TIMEOUT_MS);
  let activeWorker = null;
  let closed = false;
  let nextRequestId = 1;
  const pending = new Map();
  const terminatingWorkers = new Set();

  function finishRequest(id, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  function terminateWorker(worker) {
    const termination = worker.terminate().catch(() => {}).finally(() => {
      terminatingWorkers.delete(termination);
    });
    terminatingWorkers.add(termination);
    return termination;
  }

  function failWorker(worker, result, terminate = true) {
    if (activeWorker === worker) activeWorker = null;
    for (const [id, entry] of pending) {
      if (entry.worker === worker) finishRequest(id, result);
    }
    if (terminate) terminateWorker(worker);
  }

  function startWorker() {
    const worker = new Worker(workerPath);
    worker.unref();
    activeWorker = worker;
    worker.on("message", (message) => {
      const id = Number(message?.id);
      const entry = pending.get(id);
      if (!entry || entry.worker !== worker) return;
      finishRequest(id, entry.sanitizeResult(message.result));
    });
    worker.on("messageerror", () => {
      failWorker(
        worker,
        failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX worker could not return its response.")
      );
    });
    worker.on("error", () => {
      failWorker(worker, failure("WORKER_ERROR", "The bundled SyncTeX worker failed."));
    });
    worker.on("exit", (code) => {
      if (activeWorker !== worker) return;
      failWorker(
        worker,
        failure(
          "WORKER_EXIT",
          code === 0
            ? "The bundled SyncTeX worker stopped before completing the lookup."
            : "The bundled SyncTeX worker exited unexpectedly."
        ),
        false
      );
    });
    return worker;
  }

  async function runLookup(operation, input = {}, lookupOptions = {}) {
    if (closed) {
      return failure("WORKER_CLOSED", "The bundled SyncTeX worker is unavailable.");
    }
    const worker = activeWorker || startWorker();
    const id = nextRequestId;
    nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
    const timeoutMs = boundedTimeout(lookupOptions.workerTimeoutMs, defaultTimeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finishRequest(
          id,
          failure(
            "WORKER_TIMEOUT",
            operation === "forward"
              ? "The bundled SyncTeX reader timed out while mapping this source position to the PDF."
              : "The bundled SyncTeX reader timed out while mapping this PDF."
          )
        );
        failWorker(
          worker,
          failure("WORKER_RESTARTED", "The bundled SyncTeX worker restarted after a timed-out lookup.")
        );
      }, timeoutMs);
      pending.set(id, {
        resolve,
        timer,
        worker,
        sanitizeResult: operation === "forward" ? sanitizeForwardResult : sanitizeReverseResult
      });
      try {
        worker.postMessage({
          id,
          operation,
          input: operation === "forward" ? sanitizedForwardInput(input) : sanitizedInput(input),
          options: sanitizedLimits(lookupOptions)
        });
      } catch {
        finishRequest(id, failure("WORKER_PROTOCOL_ERROR", "The bundled SyncTeX lookup could not be started."));
      }
    });
  }

  function lookup(input = {}, lookupOptions = {}) {
    return runLookup("reverse", input, lookupOptions);
  }

  function lookupSource(input = {}, lookupOptions = {}) {
    return runLookup("forward", input, lookupOptions);
  }

  async function close() {
    if (closed) return;
    closed = true;
    const worker = activeWorker;
    activeWorker = null;
    for (const id of [...pending.keys()]) {
      finishRequest(id, failure("WORKER_CLOSED", "The bundled SyncTeX worker is unavailable."));
    }
    if (worker) terminateWorker(worker);
    await Promise.allSettled([...terminatingWorkers]);
  }

  return { lookup, lookupSource, close };
}

module.exports = {
  DEFAULT_WORKER_TIMEOUT_MS,
  createSynctexWorkerClient
};
