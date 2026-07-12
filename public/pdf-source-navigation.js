(function exposePdfSourceNavigation(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LocalLeafPdfSourceNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPdfSourceNavigationApi() {
  "use strict";

  function isPdfHyperlinkTarget(target) {
    return Boolean(target?.closest?.(".pdf-page a[href], .annotationLayer a[href], a[data-pdf-link]"));
  }

  async function revealPdfSourceFile(source, options = {}) {
    if (!source?.ok || !source.path) return false;
    if (typeof options.selectFile !== "function" || typeof options.selectedPath !== "function") return false;
    const isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : () => true;
    if (!isCurrent()) return false;
    const selected = await options.selectFile(source.path, { isCurrent });
    if (selected !== true || !isCurrent()) return false;
    return options.selectedPath() === source.path;
  }

  function createPdfSourceNavigationController(options = {}) {
    if (typeof options.lookup !== "function" || typeof options.reveal !== "function") {
      throw new TypeError("PDF source navigation requires lookup and reveal functions.");
    }
    const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
    let sequence = 0;
    let revealTail = Promise.resolve();

    async function navigate(target) {
      const requestId = ++sequence;
      onStatus({ state: "mapping" });
      let source;
      try {
        source = await options.lookup(target);
      } catch (error) {
        source = {
          ok: false,
          state: "unavailable",
          reason: error?.message || "Could not map this PDF location."
        };
      }
      if (requestId !== sequence) return { ok: false, superseded: true };
      if (!source?.ok) {
        const unavailable = {
          ok: false,
          state: source?.state || "unavailable",
          retryable: Boolean(source?.retryable),
          reason: source?.reason || "That PDF location is not mapped to editable source."
        };
        onStatus(unavailable);
        return unavailable;
      }

      const reveal = async () => {
        if (requestId !== sequence) return { ok: false, superseded: true };
        const revealed = await options.reveal(source, { isCurrent: () => requestId === sequence });
        if (revealed === false) throw new Error("Could not open the mapped source location.");
        if (requestId !== sequence) return { ok: false, superseded: true };
        onStatus({ state: "ready", source });
        return source;
      };
      const result = revealTail.then(reveal, reveal);
      revealTail = result.catch(() => undefined);
      try {
        return await result;
      } catch (error) {
        if (requestId !== sequence) return { ok: false, superseded: true };
        const unavailable = {
          ok: false,
          state: "unavailable",
          reason: error?.message || "Could not open the mapped source location."
        };
        onStatus(unavailable);
        return unavailable;
      }
    }

    return {
      navigate,
      cancel() {
        sequence += 1;
      }
    };
  }

  function createPdfOutputNavigationController(options = {}) {
    if (typeof options.lookup !== "function" || typeof options.reveal !== "function") {
      throw new TypeError("PDF output navigation requires lookup and reveal functions.");
    }
    const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
    let sequence = 0;
    let revealTail = Promise.resolve();

    async function navigate(target) {
      const requestId = ++sequence;
      onStatus({ state: "locating", target });
      let output;
      try {
        output = await options.lookup(target);
      } catch (error) {
        output = {
          ok: false,
          state: "unavailable",
          reason: error?.message || "Could not locate this change in the PDF."
        };
      }
      if (requestId !== sequence) return { ok: false, superseded: true };
      if (!output?.ok) {
        const unavailable = {
          ok: false,
          state: output?.state || "unavailable",
          retryable: Boolean(output?.retryable),
          recompileRequired: Boolean(output?.recompileRequired),
          reason: output?.reason || "This source location is not mapped in the current PDF."
        };
        onStatus(unavailable);
        return unavailable;
      }

      const reveal = async () => {
        if (requestId !== sequence) return { ok: false, superseded: true };
        const revealed = await options.reveal(output, { isCurrent: () => requestId === sequence });
        if (revealed === false) throw new Error("The mapped PDF page is not ready to display.");
        if (requestId !== sequence) return { ok: false, superseded: true };
        onStatus({ state: "ready", output });
        return output;
      };
      const result = revealTail.then(reveal, reveal);
      revealTail = result.catch(() => undefined);
      try {
        return await result;
      } catch (error) {
        if (requestId !== sequence) return { ok: false, superseded: true };
        const unavailable = {
          ok: false,
          state: "unavailable",
          reason: error?.message || "Could not show the mapped PDF location."
        };
        onStatus(unavailable);
        return unavailable;
      }
    }

    return {
      navigate,
      cancel() {
        sequence += 1;
      }
    };
  }

  return {
    createPdfOutputNavigationController,
    createPdfSourceNavigationController,
    isPdfHyperlinkTarget,
    revealPdfSourceFile
  };
});
