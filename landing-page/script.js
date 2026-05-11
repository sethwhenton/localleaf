const header = document.querySelector("[data-header]");
document.documentElement.classList.add("js-enabled");
const revealItems = document.querySelectorAll(".reveal");
const previewSection = document.querySelector("[data-scroll-preview]");
const previewScreens = document.querySelectorAll("[data-preview-screen]");
const previewStep = document.querySelector("[data-preview-step]");
const previewTitle = document.querySelector("[data-preview-title]");
const previewCopy = document.querySelector("[data-preview-copy]");
const previewWindowTitle = document.querySelector("[data-preview-window-title]");
const flowSection = document.querySelector(".flow-section");
const finalCta = document.querySelector(".final-cta");

const previewStates = [
  {
    step: "1 / 4",
    title: "Open a project",
    windowTitle: "LocalLeaf Host",
    copy:
      "Start with an existing LaTeX folder or import a ZIP. LocalLeaf keeps the files on the host computer.",
  },
  {
    step: "2 / 4",
    title: "Host the room",
    windowTitle: "Session Management",
    copy:
      "Start a session, copy the temporary link, and approve collaborators as they join.",
  },
  {
    step: "3 / 4",
    title: "Write together",
    windowTitle: "Browser Editor",
    copy:
      "Everyone edits in the browser with source, preview, chat, files, logs, and collaborators in one place.",
  },
  {
    step: "4 / 4",
    title: "Compile locally",
    windowTitle: "Compiled Output",
    copy:
      "Build the PDF on the host computer, export your work, then stop the session when the project is done.",
  },
];

let activePreview = 0;
let lastScrollY = window.scrollY;
let ticking = false;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let smoothScrollFrame = 0;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const easeScroll = (progress) => 1 - Math.pow(1 - progress, 3.4);

const initSmoothScroll = () => {
  if (prefersReducedMotion.matches || typeof window.Lenis !== "function") return null;

  const isMobile =
    window.matchMedia("(max-width: 768px)").matches ||
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0;

  const lenis = new window.Lenis({
    lerp: isMobile ? 0.18 : 0.025,
    duration: isMobile ? 0.12 : 1.15,
    easing: (t) => 1 - Math.pow(1 - t, 4),
    smoothWheel: !isMobile,
    smoothTouch: false,
    syncTouch: false,
    touchMultiplier: isMobile ? 1.6 : 0.9,
    wheelMultiplier: 1,
    normalizeWheel: true,
    infinite: false,
    anchors: {
      offset: -88,
      duration: 1.1,
      easing: (t) => 1 - Math.pow(1 - t, 4),
    },
    prevent: (node) =>
      node.closest?.(".nav-links") ||
      node.closest?.("details") ||
      node.closest?.("[data-lenis-prevent]"),
  });

  const raf = (time) => {
    lenis.raf(time);
    smoothScrollFrame = window.requestAnimationFrame(raf);
  };

  smoothScrollFrame = window.requestAnimationFrame(raf);
  lenis.on("scroll", updateOnScroll);
  window.localLeafLenis = lenis;
  return lenis;
};

const updateHeader = () => {
  if (!header) return;
  const currentY = window.scrollY;
  const goingDown = currentY > lastScrollY + 2;
  const goingUp = currentY < lastScrollY - 2;
  const pageEnd = document.documentElement.scrollHeight - window.innerHeight;
  const atEnd = currentY >= pageEnd - 12;

  header.classList.toggle("is-scrolled", currentY > 10);

  if (atEnd || goingUp) {
    header.classList.remove("is-hidden");
  } else if (goingDown || currentY <= 12) {
    header.classList.add("is-hidden");
  }

  lastScrollY = currentY;
};

const setPreview = (index) => {
  activePreview = (index + previewStates.length) % previewStates.length;
  const state = previewStates[activePreview];

  previewScreens.forEach((screen, screenIndex) => {
    screen.classList.toggle("is-active", screenIndex === activePreview);
  });

  if (previewStep) previewStep.textContent = state.step;
  if (previewTitle) previewTitle.textContent = state.title;
  if (previewCopy) previewCopy.textContent = state.copy;
  if (previewWindowTitle) previewWindowTitle.textContent = state.windowTitle;
};

const updateScrollPreview = () => {
  if (!previewSection) return;
  const rect = previewSection.getBoundingClientRect();
  const distance = Math.max(1, rect.height - window.innerHeight);
  const progress = Math.min(1, Math.max(0, -rect.top / distance));
  const index = Math.min(previewStates.length - 1, Math.floor(progress * previewStates.length));
  setPreview(index);
};

const updateFlowMotion = () => {
  if (!flowSection) return;

  if (prefersReducedMotion.matches) {
    flowSection.style.setProperty("--flow-shift", "0px");
    flowSection.style.setProperty("--flow-scale", "1");
    return;
  }

  const rect = flowSection.getBoundingClientRect();
  const start = window.innerHeight * 1.05;
  const end = window.innerHeight * 0.02;
  const progress = clamp((start - rect.top) / Math.max(1, start - end));
  const eased = 1 - Math.pow(1 - progress, 1.55);
  const maxShift = Math.min(window.innerWidth <= 820 ? 150 : 620, window.innerWidth * 0.42);
  const shift = (1 - eased) * maxShift;
  const scale = 0.985 + eased * 0.015;

  flowSection.style.setProperty("--flow-shift", `${shift.toFixed(1)}px`);
  flowSection.style.setProperty("--flow-scale", scale.toFixed(3));
};

const updateScrollReveals = () => {
  if (prefersReducedMotion.matches) {
    revealItems.forEach((item) => {
      item.style.opacity = "1";
      item.style.transform = "none";
      item.style.filter = "none";
    });
    return;
  }

  const start = window.innerHeight * 0.72;
  const end = window.innerHeight * 0.4;

  revealItems.forEach((item) => {
    const rect = item.getBoundingClientRect();
    const offset = Number(item.dataset.revealOffset || 0);
    const isFlowStep = item.classList.contains("flow-step");
    const qaSection = item.closest(".qa-section");
    const centerSnapSection = item.closest(".flow-section, .qa-section, .final-cta");
    const sectionRect = centerSnapSection?.getBoundingClientRect();
    const centerThreshold = qaSection ? 0.52 : 0.34;
    const sectionIsCentered = sectionRect
      ? Math.abs(sectionRect.top + sectionRect.height / 2 - window.innerHeight / 2) <=
        window.innerHeight * centerThreshold
      : false;
    const peekOpacity = item.classList.contains("reveal-peek") ? 0.24 : isFlowStep ? 0.18 : 0;
    const revealBoost = qaSection ? 0.3 : 0;
    const rawProgress = (start - rect.top) / Math.max(1, start - end) - offset + revealBoost;
    const progress = sectionIsCentered ? 1 : clamp(rawProgress);
    const eased = easeScroll(progress);
    const lift = (1 - eased) * (isFlowStep ? 28 : 56);
    const blur = (1 - eased) * (isFlowStep ? 5 : 10);
    const scale = 0.97 + eased * 0.03;

    item.style.opacity = Math.max(peekOpacity, eased).toFixed(3);
    item.style.transform = `translate3d(0, ${lift.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
    item.style.filter = blur > 0.12 ? `blur(${blur.toFixed(2)}px)` : "none";
  });
};

const updateSectionAnimationStates = () => {
  if (!finalCta) return;
  const rect = finalCta.getBoundingClientRect();
  const isVisible = rect.top < window.innerHeight * 0.72 && rect.bottom > window.innerHeight * 0.2;
  finalCta.classList.toggle("is-final-visible", isVisible);
};

const updateOnScroll = () => {
  if (ticking) return;
  ticking = true;
  window.requestAnimationFrame(() => {
    updateHeader();
    updateScrollPreview();
    updateFlowMotion();
    updateSectionAnimationStates();
    updateScrollReveals();
    ticking = false;
  });
};

document.querySelectorAll(".flow-step").forEach((step, index) => {
  step.dataset.revealOffset = `${index * 0.025}`;
});

document.querySelectorAll(".final-cta .reveal").forEach((item, index) => {
  item.dataset.revealOffset = `${index * 0.035}`;
});

const smoothScroller = initSmoothScroll();

window.addEventListener("scroll", updateOnScroll, { passive: true });
window.addEventListener("resize", () => {
  smoothScroller?.resize?.();
  updateOnScroll();
});
window.addEventListener("load", () => smoothScroller?.resize?.(), { once: true });
prefersReducedMotion.addEventListener?.("change", () => {
  if (prefersReducedMotion.matches) {
    smoothScroller?.destroy?.();
    if (smoothScrollFrame) window.cancelAnimationFrame(smoothScrollFrame);
  }
  updateOnScroll();
});
updateHeader();
setPreview(0);
updateScrollPreview();
updateFlowMotion();
updateSectionAnimationStates();
updateScrollReveals();
