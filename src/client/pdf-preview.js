import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { fetchPdfBytes } from "./pdf-fetch.mjs";
import { pdfExternalLinkDescriptors, scalePdfExternalLinkDescriptor } from "./pdf-links.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.bundle.js";

const viewers = new WeakMap();

function clampScale(scale) {
  return Math.max(0.5, Math.min(2.4, Number(scale) || 1));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function captureScroll(container) {
  if (!container) return null;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  const state = {
    top: container.scrollTop,
    left: container.scrollLeft,
    topRatio: maxTop ? container.scrollTop / maxTop : 0,
    leftRatio: maxLeft ? container.scrollLeft / maxLeft : 0
  };
  const pages = Array.from(container.querySelectorAll(".pdf-page[data-page-number]"));
  if (pages.length) {
    const anchorY = container.scrollTop + Math.min(72, Math.max(24, container.clientHeight * 0.12));
    const currentPage = pages.reduce((active, page) => {
      if (page.offsetTop <= anchorY) return page;
      return active;
    }, pages[0]);
    const pageHeight = Math.max(1, currentPage.offsetHeight);
    state.pageNumber = Number(currentPage.dataset.pageNumber || 1);
    state.pageOffsetRatio = Math.max(0, Math.min(1, (anchorY - currentPage.offsetTop) / pageHeight));
  }
  return state;
}

function restoreScroll(container, scrollState) {
  if (!container || !scrollState) return;
  const apply = () => {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    let nextTop = Math.max(scrollState.top, Math.round(maxTop * scrollState.topRatio));
    if (scrollState.pageNumber) {
      const page = container.querySelector(`.pdf-page[data-page-number="${scrollState.pageNumber}"]`);
      if (page) {
        const anchorOffset = Math.min(72, Math.max(24, container.clientHeight * 0.12));
        nextTop = page.offsetTop + Math.round(page.offsetHeight * (scrollState.pageOffsetRatio || 0)) - anchorOffset;
      }
    }
    container.scrollTop = Math.min(maxTop, Math.max(0, nextTop));
    container.scrollLeft = Math.min(maxLeft, Math.max(scrollState.left, Math.round(maxLeft * scrollState.leftRatio)));
  };
  requestAnimationFrame(() => {
    apply();
    setTimeout(apply, 80);
    setTimeout(apply, 260);
  });
}

function cancelViewer(state) {
  if (!state) return;
  state.cancelled = true;
  state.revealWaiters?.forEach((waiter) => {
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  });
  state.revealWaiters?.clear?.();
  state.abortController?.abort?.();
  state.loadingTask?.destroy?.();
  state.renderTasks?.forEach((task) => task?.cancel?.());
  state.renderTasks?.clear?.();
  state.document?.destroy?.();
}

function finitePdfPosition(target = {}) {
  const page = Number(target.page);
  const x = Number(target.x);
  const y = Number(target.y);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
    return null;
  }
  return {
    ...target,
    page,
    x,
    y,
    width: Math.max(0, Number(target.width) || 0),
    height: Math.max(0, Number(target.height) || 0),
    artifactId: String(target.artifactId || ""),
    version: Number(target.version || 0)
  };
}

function viewerMatchesPosition(state, target) {
  if (!state || state.cancelled) return false;
  if (target.artifactId && state.artifactId && target.artifactId !== state.artifactId) return false;
  if (!target.artifactId && target.version && state.version && target.version !== state.version) return false;
  return true;
}

function showPdfPosition(container, state, rawTarget) {
  const target = finitePdfPosition(rawTarget);
  if (!container || !target || !viewerMatchesPosition(state, target)) return false;
  const page = container.querySelector(`.pdf-page[data-page-number="${target.page}"]`);
  if (!page) return false;

  container.querySelectorAll(".pdf-review-target").forEach((marker) => marker.remove());
  const scale = Number(state.scale || 1);
  const pageWidth = Math.max(1, page.clientWidth || Number.parseFloat(page.style.width) || 1);
  const pageHeight = Math.max(1, page.clientHeight || page.querySelector("canvas")?.clientHeight || 1);
  const markerWidth = Math.min(pageWidth, Math.max(28, target.width * scale));
  const markerHeight = Math.min(pageHeight, Math.max(16, target.height * scale));
  const left = Math.max(0, Math.min(pageWidth - markerWidth, target.x * scale));
  const top = Math.max(0, Math.min(pageHeight - markerHeight, target.y * scale));
  const marker = document.createElement("div");
  marker.className = "pdf-review-target";
  marker.dataset.pageNumber = String(target.page);
  marker.setAttribute("aria-hidden", "true");
  marker.style.left = `${left}px`;
  marker.style.top = `${top}px`;
  marker.style.width = `${markerWidth}px`;
  marker.style.height = `${markerHeight}px`;
  page.append(marker);

  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  container.scrollTop = Math.max(0, Math.min(maxTop, page.offsetTop + top + (markerHeight / 2) - (container.clientHeight / 2)));
  container.scrollLeft = Math.max(0, Math.min(maxLeft, page.offsetLeft + left + (markerWidth / 2) - (container.clientWidth / 2)));
  state.lastRevealTarget = target;
  state.reviewRevealed = true;
  return true;
}

function flushPdfPositionWaiters(container, state) {
  if (!state?.revealWaiters?.size) return;
  for (const waiter of [...state.revealWaiters]) {
    if (!showPdfPosition(container, state, waiter.target)) continue;
    state.revealWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

function revealPosition(container, rawTarget) {
  const state = viewers.get(container);
  const target = finitePdfPosition(rawTarget);
  if (!state || !target || !viewerMatchesPosition(state, target)) return Promise.resolve(false);
  if (showPdfPosition(container, state, target)) return Promise.resolve(true);
  if (state.document && target.page > state.document.numPages) return Promise.resolve(false);

  return new Promise((resolve) => {
    const waiter = { target, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      state.revealWaiters.delete(waiter);
      resolve(false);
    }, 15_000);
    state.revealWaiters.add(waiter);
  });
}

function resizeExistingPages(container, nextScale, previousScale) {
  const ratio = previousScale ? nextScale / previousScale : 1;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return;
  const measurements = Array.from(container.querySelectorAll(".pdf-page")).map((pageShell) => {
    const canvas = pageShell.querySelector(".pdf-page-canvas");
    const textLayer = pageShell.querySelector(".textLayer");
    const pageWidth = Number.parseFloat(pageShell.style.width || pageShell.offsetWidth);
    const canvasWidth = Number.parseFloat(canvas?.style.width || canvas?.offsetWidth || pageWidth);
    const canvasHeight = Number.parseFloat(canvas?.style.height || canvas?.offsetHeight || 0);
    const linkHitboxes = Array.from(pageShell.querySelectorAll(".pdf-link-layer a[data-pdf-link]")).map((anchor) => ({
      anchor,
      left: Number.parseFloat(anchor.style.left),
      top: Number.parseFloat(anchor.style.top),
      width: Number.parseFloat(anchor.style.width),
      height: Number.parseFloat(anchor.style.height)
    }));
    return { pageShell, canvas, textLayer, pageWidth, canvasWidth, canvasHeight, linkHitboxes };
  });
  measurements.forEach(({ pageShell, canvas, textLayer, pageWidth, canvasWidth, canvasHeight, linkHitboxes }) => {
    if (pageWidth) pageShell.style.width = `${pageWidth * ratio}px`;
    if (canvas) {
      if (canvasWidth) canvas.style.width = `${canvasWidth * ratio}px`;
      if (canvasHeight) canvas.style.height = `${canvasHeight * ratio}px`;
    }
    if (textLayer) {
      if (canvasWidth) textLayer.style.width = `${canvasWidth * ratio}px`;
      if (canvasHeight) textLayer.style.height = `${canvasHeight * ratio}px`;
    }
    linkHitboxes.forEach(({ anchor, ...descriptor }) => {
      const scaled = scalePdfExternalLinkDescriptor(descriptor, ratio);
      if (!scaled) return;
      anchor.style.left = `${scaled.left}px`;
      anchor.style.top = `${scaled.top}px`;
      anchor.style.width = `${scaled.width}px`;
      anchor.style.height = `${scaled.height}px`;
    });
  });
}

async function renderExternalLinkLayer(page, viewport, pageShell) {
  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: "display" });
  } catch {
    return;
  }
  const links = pdfExternalLinkDescriptors(
    annotations,
    (rect) => viewport.convertToViewportRectangle(rect)
  );
  if (!links.length) return;

  const layer = document.createElement("div");
  layer.className = "annotationLayer pdf-link-layer";
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.zIndex = "2";
  layer.style.pointerEvents = "none";
  links.forEach((link) => {
    const anchor = document.createElement("a");
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.referrerPolicy = "no-referrer";
    anchor.dataset.pdfLink = "external";
    anchor.setAttribute("aria-label", link.label);
    anchor.title = link.label;
    anchor.style.position = "absolute";
    anchor.style.left = `${link.left}px`;
    anchor.style.top = `${link.top}px`;
    anchor.style.width = `${link.width}px`;
    anchor.style.height = `${link.height}px`;
    anchor.style.pointerEvents = "auto";
    anchor.style.cursor = "pointer";
    anchor.addEventListener("click", (event) => event.stopPropagation());
    layer.append(anchor);
  });
  pageShell.append(layer);
}

async function renderPage(page, scale, state) {
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const pageShell = document.createElement("section");
  pageShell.className = "pdf-page";
  pageShell.style.width = `${viewport.width}px`;

  const canvas = document.createElement("canvas");
  canvas.className = "pdf-page-canvas";
  canvas.width = Math.ceil(viewport.width * dpr);
  canvas.height = Math.ceil(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const context = canvas.getContext("2d", { alpha: false });
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  pageShell.append(canvas);
  const renderTask = page.render({ canvasContext: context, viewport });
  state?.renderTasks?.add(renderTask);
  try {
    await renderTask.promise;
  } finally {
    state?.renderTasks?.delete(renderTask);
  }

  if (pdfjsLib.TextLayer) {
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer pdf-text-layer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    pageShell.append(textLayer);
    const textContent = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true
    });
    const layer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport
    });
    await layer.render();
  }

  await renderExternalLinkLayer(page, viewport, pageShell);

  return pageShell;
}

async function mount(container, options = {}) {
  if (!container || !options.url) return null;
  const previous = viewers.get(container);
  cancelViewer(previous);

  const state = {
    cancelled: false,
    url: options.url,
    scale: clampScale(options.scale),
    document: null,
    abortController: new AbortController(),
    loadingTask: null,
    renderTasks: new Set(),
    revealWaiters: new Set(),
    artifactId: String(options.artifactId || ""),
    version: Number(options.version || 0),
    options
  };
  viewers.set(container, state);

  container.innerHTML = `
    <div class="pdf-render-status">
      <span class="big-spinner"></span>
      <strong>Loading PDF preview</strong>
    </div>
  `;

  try {
    const data = await fetchPdfBytes(options.url, { signal: state.abortController.signal });
    if (state.cancelled) return state;
    const loadingTask = pdfjsLib.getDocument({ data });
    state.loadingTask = loadingTask;
    const pdf = await loadingTask.promise;
    state.document = pdf;

    if (state.cancelled) return state;
    container.innerHTML = "";
    const documentShell = document.createElement("div");
    documentShell.className = "pdf-document";
    container.append(documentShell);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (state.cancelled) return state;
      const page = await pdf.getPage(pageNumber);
      const pageShell = await renderPage(page, state.scale, state);
      if (state.cancelled) return state;
      pageShell.dataset.pageNumber = String(pageNumber);
      documentShell.append(pageShell);
      flushPdfPositionWaiters(container, state);
      if (!state.reviewRevealed && options.scrollState?.pageNumber === pageNumber) {
        restoreScroll(container, options.scrollState);
      }
    }

    if (!state.reviewRevealed) restoreScroll(container, options.scrollState);
    state.revealWaiters.forEach((waiter) => {
      state.revealWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    });
    options.onReady?.({ pageCount: pdf.numPages, url: options.url });
    return state;
  } catch (error) {
    if (!state.cancelled && error?.name !== "AbortError") {
      options.onError?.(error);
      container.innerHTML = `
        <div class="pdf-render-status pdf-render-error">
          <strong>Your PDF compiled, but the preview could not load</strong>
          <span>${escapeHtml(error.message || error)}</span>
          <span class="pdf-render-actions">
            <button type="button" class="secondary-button" data-pdf-retry>Retry preview</button>
            <a class="secondary-button" href="${escapeHtml(options.url)}" target="_blank" rel="noopener">Open PDF</a>
          </span>
        </div>
      `;
      container.querySelector("[data-pdf-retry]")?.addEventListener("click", () => {
        mount(container, {
          ...options,
          scrollState: options.scrollState || captureScroll(container)
        });
      });
    }
    return state;
  }
}

function remount(container, nextOptions = {}) {
  const state = viewers.get(container);
  if (!state) return null;
  return mount(container, {
    url: nextOptions.url || state.url,
    scale: nextOptions.scale || state.scale,
    scrollState: nextOptions.scrollState || captureScroll(container),
    artifactId: nextOptions.artifactId || state.artifactId,
    version: nextOptions.version || state.version
  });
}

async function zoom(container, nextOptions = {}) {
  const state = viewers.get(container);
  if (!container || !state?.document) return remount(container, nextOptions);
  const nextScale = clampScale(nextOptions.scale || state.scale);
  if (nextScale === state.scale) return state;
  const scrollState = nextOptions.scrollState || captureScroll(container);
  const previousScale = state.scale;
  state.scale = nextScale;
  state.zoomToken = (state.zoomToken || 0) + 1;
  const token = state.zoomToken;

  resizeExistingPages(container, nextScale, previousScale);
  if (!state.reviewRevealed) restoreScroll(container, scrollState);

  for (let pageNumber = 1; pageNumber <= state.document.numPages; pageNumber += 1) {
    if (state.cancelled || state.zoomToken !== token) return state;
    const page = await state.document.getPage(pageNumber);
    const pageShell = await renderPage(page, nextScale, state);
    if (state.cancelled || state.zoomToken !== token) return state;
    pageShell.dataset.pageNumber = String(pageNumber);
    const existing = container.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
    if (existing) existing.replaceWith(pageShell);
    else container.querySelector(".pdf-document")?.append(pageShell);
    if (state.lastRevealTarget?.page === pageNumber) showPdfPosition(container, state, state.lastRevealTarget);
    if (!state.reviewRevealed && pageNumber === scrollState?.pageNumber) restoreScroll(container, scrollState);
  }

  if (!state.reviewRevealed) restoreScroll(container, scrollState);
  return state;
}

window.LocalLeafPdfPreview = {
  cancel(container) {
    cancelViewer(viewers.get(container));
  },
  captureScroll,
  mount,
  remount,
  restoreScroll,
  revealPosition,
  zoom
};
