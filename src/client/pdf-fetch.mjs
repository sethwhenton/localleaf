export const RETRYABLE_PDF_STATUSES = new Set([404, 409, 425, 429, 502, 503, 504]);
export const PDF_FETCH_RETRY_DELAYS = [180, 480];
export const PDF_FETCH_TIMEOUT_MS = 8000;

function abortError(message = "PDF preview load was cancelled") {
  return new DOMException(message, "AbortError");
}

function waitForRetry(delay, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function timedAttemptSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason || abortError());
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("PDF preview request timed out", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

export async function fetchPdfBytes(url, options = {}) {
  const signal = options.signal;
  const fetchImpl = options.fetchImpl || fetch;
  const retryDelays = options.retryDelays || PDF_FETCH_RETRY_DELAYS;
  const timeoutMs = Math.max(100, Number(options.timeoutMs || PDF_FETCH_TIMEOUT_MS));
  let lastError = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const timedSignal = timedAttemptSignal(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, { cache: "no-store", signal: timedSignal.signal });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      const error = new Error(`Could not load PDF (${response.status})`);
      error.status = response.status;
      if (!RETRYABLE_PDF_STATUSES.has(response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (Number.isInteger(error?.status) && !RETRYABLE_PDF_STATUSES.has(error.status)) throw error;
      lastError = timedSignal.didTimeOut()
        ? new Error("PDF preview request timed out")
        : error;
    } finally {
      timedSignal.cleanup();
    }

    const delay = retryDelays[attempt];
    if (delay === undefined) break;
    await waitForRetry(delay, signal);
  }
  throw lastError || new Error("Could not load PDF preview");
}
