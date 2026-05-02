import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.bundle.js";

const viewers = new WeakMap();

function clampScale(scale) {
  return Math.max(0.5, Math.min(2.4, Number(scale) || 1));
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

function resizeExistingPages(container, nextScale, previousScale) {
  const ratio = previousScale ? nextScale / previousScale : 1;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return;
  container.querySelectorAll(".pdf-page").forEach((pageShell) => {
    const canvas = pageShell.querySelector(".pdf-page-canvas");
    const pageWidth = Number.parseFloat(pageShell.style.width || pageShell.offsetWidth);
    const canvasWidth = Number.parseFloat(canvas?.style.width || canvas?.offsetWidth || pageWidth);
    const canvasHeight = Number.parseFloat(canvas?.style.height || canvas?.offsetHeight || 0);
    if (pageWidth) pageShell.style.width = `${pageWidth * ratio}px`;
    if (canvas) {
      if (canvasWidth) canvas.style.width = `${canvasWidth * ratio}px`;
      if (canvasHeight) canvas.style.height = `${canvasHeight * ratio}px`;
    }
  });
}

async function renderPage(page, scale) {
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
  await page.render({ canvasContext: context, viewport }).promise;
  return pageShell;
}

async function mount(container, options = {}) {
  if (!container || !options.url) return null;
  const previous = viewers.get(container);
  if (previous) {
    previous.cancelled = true;
    previous.document?.destroy?.();
  }

  const state = {
    cancelled: false,
    url: options.url,
    scale: clampScale(options.scale),
    document: null
  };
  viewers.set(container, state);

  container.innerHTML = `
    <div class="pdf-render-status">
      <span class="big-spinner"></span>
      <strong>Loading PDF preview</strong>
    </div>
  `;

  try {
    const response = await fetch(options.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load PDF (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data });
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
      const pageShell = await renderPage(page, state.scale);
      if (state.cancelled) return state;
      pageShell.dataset.pageNumber = String(pageNumber);
      documentShell.append(pageShell);
      if (options.scrollState?.pageNumber === pageNumber) {
        restoreScroll(container, options.scrollState);
      }
    }

    restoreScroll(container, options.scrollState);
    return state;
  } catch (error) {
    if (!state.cancelled) {
      container.innerHTML = `
        <div class="pdf-render-status pdf-render-error">
          <strong>Could not render PDF preview</strong>
          <span>${String(error.message || error)}</span>
        </div>
      `;
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
    scrollState: nextOptions.scrollState || captureScroll(container)
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
  restoreScroll(container, scrollState);

  for (let pageNumber = 1; pageNumber <= state.document.numPages; pageNumber += 1) {
    if (state.cancelled || state.zoomToken !== token) return state;
    const page = await state.document.getPage(pageNumber);
    const pageShell = await renderPage(page, nextScale);
    if (state.cancelled || state.zoomToken !== token) return state;
    pageShell.dataset.pageNumber = String(pageNumber);
    const existing = container.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
    if (existing) existing.replaceWith(pageShell);
    else container.querySelector(".pdf-document")?.append(pageShell);
    if (pageNumber === scrollState?.pageNumber) restoreScroll(container, scrollState);
  }

  restoreScroll(container, scrollState);
  return state;
}

window.LocalLeafPdfPreview = {
  captureScroll,
  mount,
  remount,
  restoreScroll,
  zoom
};
