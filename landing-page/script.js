document.documentElement.classList.add("js-enabled");

const header = document.querySelector("[data-header]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const previewSection = document.querySelector("[data-preview-section]");
const previewScreens = [...document.querySelectorAll("[data-preview-screen]")];
const previewStep = document.querySelector("[data-preview-step]");
const previewTitle = document.querySelector("[data-preview-title]");
const previewCopy = document.querySelector("[data-preview-copy]");
const previewWindowTitle = document.querySelector("[data-preview-window-title]");
const aiSection = document.querySelector("[data-ai-section]");
const aiImage = document.querySelector("[data-theme-image]");
const themeImages = [...document.querySelectorAll("img[data-light][data-dark]")];
const aiLayout = document.querySelector(".ai-layout");
const aiImageFrame = document.querySelector(".ai-image-frame");
const aiTitle = document.querySelector("[data-ai-title]");
const aiCopy = document.querySelector("[data-ai-copy]");
const aiPoints = document.querySelector("[data-ai-points]");
const aiCaption = document.querySelector("[data-ai-caption]");
const previewDots = [...document.querySelectorAll("[data-preview-dot]")];
const aiDots = [...document.querySelectorAll("[data-ai-dot]")];
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const previewStates = [
  {
    step: "1 / 3",
    title: "Host the room",
    windowTitle: "Session Management",
    copy: "Copy a temporary link, approve collaborators, and keep the project running from the host computer.",
  },
  {
    step: "2 / 3",
    title: "Write with people",
    windowTitle: "Browser Editor",
    copy: "Edit LaTeX, preview the PDF, and keep human chat beside the work instead of in another app.",
  },
  {
    step: "3 / 3",
    title: "Compile locally",
    windowTitle: "Compiled Output",
    copy: "Build the PDF on the host computer and inspect warnings without sending project files to a cloud workspace.",
  },
];

const aiSlides = [
  {
    title: "Let AI assist you by asking for help, then approve the edit.",
    copy:
      "The AI Helper sits inside the same right rail as Chat and Changes. It can explain LaTeX issues, draft replacements, and ask before it touches your files.",
    caption: "AI requests edit access before LocalLeaf applies a file change.",
    points: ["Approval cards before writes", "Diffs tracked in Changes", "Safe text edits by default"],
    light: "./assets/editor-ai-helper-light.png",
    dark: "./assets/editor-ai-helper-dark.png",
    alt: "LocalLeaf app layout with the AI Helper right rail open",
  },
  {
    title: "Use local models or bring your own key.",
    copy:
      "Download supported GGUF models for local help, or connect an OpenAI-compatible provider. The built-in harness routes requests and keeps edit approvals in LocalLeaf.",
    caption: "The model picker is a focused popup for local models, provider keys, and the Cursor-style edit harness.",
    points: ["Local GGUF model downloads", "OpenAI-compatible provider keys", "Cursor-style harness with approvals"],
    light: "./assets/model-picker-popup-light.png",
    dark: "./assets/model-picker-popup-dark.png",
    alt: "LocalLeaf model picker popup with local models and provider routing",
  },
  {
    title: "Connect the models you trust.",
    copy:
      "LocalLeaf supports connected providers, local runtimes, and a Cursor-style harness while keeping approvals visible in the app.",
    caption: "Provider settings keep hosted models, local models, and custom OpenAI-compatible endpoints in one place.",
    points: ["OpenCode Go and OpenAI-compatible providers", "Local Ollama or LM Studio routes", "Custom endpoints and Cursor provider presets"],
    light: "./assets/ai-providers-settings-light.png",
    dark: "./assets/ai-providers-settings-dark.png",
    alt: "LocalLeaf AI provider settings with connected and popular provider rows",
  },
];

let activePreviewIndex = 0;
let activeAiIndex = 0;
let lastScrollY = window.scrollY;
let ticking = false;
let lenisFrame = 0;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function imageForSlide(slide) {
  return currentTheme() === "dark" ? slide.dark : slide.light;
}

function updateThemeToggle() {
  if (!themeToggle) return;
  const dark = currentTheme() === "dark";
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("localleaf.landingTheme", theme);
  } catch {}
  updateThemeToggle();
  updateThemeImages();
  setAiSlide(activeAiIndex, { forceImage: true });
}

function updateThemeImages() {
  const key = currentTheme() === "dark" ? "dark" : "light";
  themeImages.forEach((image) => {
    const src = image.dataset[key];
    if (src && image.getAttribute("src") !== src) {
      image.setAttribute("src", src);
    }
  });
}

function setPreview(index) {
  if (!previewScreens.length) return;
  activePreviewIndex = clamp(index, 0, previewStates.length - 1);
  const state = previewStates[activePreviewIndex];

  previewScreens.forEach((screen, screenIndex) => {
    screen.classList.toggle("is-active", screenIndex === activePreviewIndex);
  });

  if (previewStep) previewStep.textContent = state.step;
  if (previewTitle) previewTitle.textContent = state.title;
  if (previewCopy) previewCopy.textContent = state.copy;
  if (previewWindowTitle) previewWindowTitle.textContent = state.windowTitle;
  previewDots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === activePreviewIndex));
}

function setAiSlide(index, options = {}) {
  if (!aiImage) return;
  activeAiIndex = clamp(index, 0, aiSlides.length - 1);
  const slide = aiSlides[activeAiIndex];
  const nextSrc = imageForSlide(slide);

  if (aiImage.getAttribute("src") !== nextSrc || options.forceImage) {
    aiImageFrame?.classList.add("is-swapping");
    aiImage.setAttribute("src", nextSrc);
    aiImage.setAttribute("alt", slide.alt);
    window.setTimeout(() => aiImageFrame?.classList.remove("is-swapping"), 180);
  }

  if (aiTitle) aiTitle.textContent = slide.title;
  if (aiCopy) aiCopy.textContent = slide.copy;
  if (aiCaption) aiCaption.textContent = slide.caption;
  if (aiPoints) {
    aiPoints.innerHTML = slide.points.map((point) => `<span>${point}</span>`).join("");
  }
  aiDots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === activeAiIndex));

  if (options.animate !== false) replayAiSlideAnimation();
}

function replayAiSlideAnimation() {
  if (!aiLayout || prefersReducedMotion.matches) return;
  aiLayout.classList.remove("is-slide-entering");
  void aiLayout.offsetWidth;
  aiLayout.classList.add("is-slide-entering");
  window.setTimeout(() => aiLayout.classList.remove("is-slide-entering"), 720);
}

function updateHeader() {
  if (!header) return;
  const currentY = window.scrollY;
  const goingDown = currentY > lastScrollY + 2;
  const goingUp = currentY < lastScrollY - 2;
  const pageEnd = document.documentElement.scrollHeight - window.innerHeight;
  const atEnd = currentY >= pageEnd - 18;

  header.classList.toggle("is-scrolled", currentY > 12);

  if (atEnd || goingUp) {
    header.classList.remove("is-hidden");
  } else if (goingDown || currentY <= 12) {
    header.classList.add("is-hidden");
  }

  lastScrollY = currentY;
}

function updatePreviewFromScroll() {
  if (!previewSection) return;
  const rect = previewSection.getBoundingClientRect();
  const distance = Math.max(1, rect.height - window.innerHeight);
  const progress = clamp(-rect.top / distance);
  const index = Math.min(previewStates.length - 1, Math.floor(progress * previewStates.length + 0.12));
  if (index !== activePreviewIndex) setPreview(index);
}

function updateAiFromScroll() {
  if (!aiSection) return;
  const rect = aiSection.getBoundingClientRect();
  const distance = Math.max(1, rect.height - window.innerHeight);
  const progress = clamp(-rect.top / distance);
  const index = Math.min(aiSlides.length - 1, Math.floor(progress * aiSlides.length + 0.08));
  if (index !== activeAiIndex) setAiSlide(index);
}

function updateOnScroll() {
  if (ticking) return;
  ticking = true;
  window.requestAnimationFrame(() => {
    updateHeader();
    updatePreviewFromScroll();
    updateAiFromScroll();
    revealVisibleItems();
    ticking = false;
  });
}

function initReveals() {
  const revealItems = [...document.querySelectorAll(".reveal")];
  if (prefersReducedMotion.matches || !("IntersectionObserver" in window)) {
    revealItems.forEach((item) => item.classList.add("revealed"));
    return null;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          observer.unobserve(entry.target);
        }
      });
    },
    {
      root: null,
      rootMargin: "0px 0px -8% 0px",
      threshold: 0.08,
    }
  );

  revealItems.forEach((item) => observer.observe(item));
  return observer;
}

function revealVisibleItems() {
  if (prefersReducedMotion.matches) return;
  document.querySelectorAll(".reveal:not(.revealed)").forEach((item) => {
    const rect = item.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92 && rect.bottom > window.innerHeight * 0.04) {
      item.classList.add("revealed");
    }
  });
}

function initSmoothScroll() {
  if (prefersReducedMotion.matches || typeof window.Lenis !== "function") return null;

  const isTouch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const lenis = new window.Lenis({
    duration: isTouch ? 0.85 : 1.18,
    lerp: isTouch ? 0.16 : 0.09,
    smoothWheel: true,
    smoothTouch: false,
    wheelMultiplier: 0.92,
    touchMultiplier: 1.35,
    normalizeWheel: true,
    anchors: {
      offset: -86,
      duration: 1.05,
    },
  });

  const raf = (time) => {
    lenis.raf(time);
    lenisFrame = window.requestAnimationFrame(raf);
  };

  lenisFrame = window.requestAnimationFrame(raf);
  lenis.on("scroll", updateOnScroll);
  window.localLeafLenis = lenis;
  return lenis;
}

themeToggle?.addEventListener("click", () => {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
});

const smoothScroller = initSmoothScroll();
const revealObserver = initReveals();

window.addEventListener("scroll", updateOnScroll, { passive: true });
window.addEventListener("resize", () => {
  smoothScroller?.resize?.();
  updateOnScroll();
  revealVisibleItems();
});
window.addEventListener("load", () => {
  smoothScroller?.resize?.();
  updateOnScroll();
  revealVisibleItems();
}, { once: true });

prefersReducedMotion.addEventListener?.("change", () => {
  if (prefersReducedMotion.matches) {
    smoothScroller?.destroy?.();
    if (lenisFrame) window.cancelAnimationFrame(lenisFrame);
    revealObserver?.disconnect?.();
    document.querySelectorAll(".reveal").forEach((item) => item.classList.add("revealed"));
  }
});

updateThemeToggle();
updateThemeImages();
setPreview(0);
setAiSlide(0, { forceImage: true, animate: false });
updateOnScroll();
revealVisibleItems();
