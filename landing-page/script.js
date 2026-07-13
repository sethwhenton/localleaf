document.documentElement.classList.add("js");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(pointer: fine)");
const desktopLayout = window.matchMedia("(min-width: 761px)");
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = (start, end, value) => {
  const amount = clamp((value - start) / Math.max(0.0001, end - start));
  return amount * amount * (3 - 2 * amount);
};

const header = document.querySelector("[data-header]");
const progressBar = document.querySelector("[data-progress]");
const toneSections = [...document.querySelectorAll("[data-header-tone]")];
const hero = document.querySelector(".hero");
const wordmark = document.querySelector(".balloon-wordmark");
const heroCopy = document.querySelector("[data-hero-copy]");
const parallaxPrints = [...document.querySelectorAll("[data-parallax]")];
const manifesto = document.querySelector(".manifesto");
const manifestoImage = document.querySelector(".manifesto-image");
const storyFilm = document.querySelector(".story-film");
const storyImage = document.querySelector(".story-film > img");
const stackStage = document.querySelector("[data-stack-stage]");
const stackCards = [...document.querySelectorAll("[data-stack-card]")];

let scrollFrame = 0;

function updateHeaderTone() {
  if (!header) return;
  const sampleY = Math.min(78, window.innerHeight * 0.12);
  const active = toneSections.find((section) => {
    const rect = section.getBoundingClientRect();
    return rect.top <= sampleY && rect.bottom > sampleY;
  });
  header.classList.toggle("is-dark", active?.dataset.headerTone === "dark");
}

function updateStackCards() {
  if (!stackStage || !stackCards.length || !desktopLayout.matches || reducedMotion.matches) return;

  const rect = stackStage.getBoundingClientRect();
  const distance = Math.max(1, rect.height - window.innerHeight);
  const progress = clamp(-rect.top / distance);
  const viewport = window.innerHeight;
  const timings = [
    { enterStart: -1, enterEnd: 0, exitStart: 0.3, exitEnd: 0.53, baseRotation: -0.8 },
    { enterStart: 0.17, enterEnd: 0.34, exitStart: 0.6, exitEnd: 0.82, baseRotation: 0.9 },
    { enterStart: 0.5, enterEnd: 0.7, exitStart: 2, exitEnd: 3, baseRotation: -0.55 },
  ];

  stackCards.forEach((card, index) => {
    const timing = timings[index];
    const entered = index === 0 ? 1 : smoothstep(timing.enterStart, timing.enterEnd, progress);
    const exited = smoothstep(timing.exitStart, timing.exitEnd, progress);
    const y = (1 - entered) * viewport * 0.92 - exited * viewport * 0.86;
    const scale = 0.84 + entered * 0.16 - exited * 0.045;
    const rotation = timing.baseRotation + exited * (index % 2 === 0 ? -2.3 : 2.1);
    const opacity = clamp(entered * 1.4) * (1 - exited * 0.32);

    card.style.setProperty("--card-y", `${y.toFixed(2)}px`);
    card.style.setProperty("--card-scale", scale.toFixed(4));
    card.style.setProperty("--card-rotate", `${rotation.toFixed(3)}deg`);
    card.style.setProperty("--card-opacity", opacity.toFixed(3));
  });
}

function updateParallax() {
  if (reducedMotion.matches || !desktopLayout.matches) return;

  if (hero) {
    const rect = hero.getBoundingClientRect();
    const amount = clamp(-rect.top / Math.max(1, rect.height), 0, 1.2);
    wordmark?.style.setProperty("--parallax-y", `${(-amount * 105).toFixed(2)}px`);
    heroCopy?.style.setProperty("--hero-y", `${(-amount * 34).toFixed(2)}px`);
    parallaxPrints.forEach((print) => {
      const speed = Number(print.dataset.parallax || 0);
      print.style.setProperty("--parallax-y", `${(amount * speed * 360).toFixed(2)}px`);
    });
  }

  if (manifesto && manifestoImage) {
    const rect = manifesto.getBoundingClientRect();
    const position = clamp((window.innerHeight - rect.top) / (window.innerHeight + rect.height));
    manifestoImage.style.setProperty("--media-y", `${((position - 0.5) * 58).toFixed(2)}px`);
  }

  if (storyFilm && storyImage) {
    const rect = storyFilm.getBoundingClientRect();
    const position = clamp((window.innerHeight - rect.top) / (window.innerHeight + rect.height));
    storyImage.style.setProperty("--media-y", `${((position - 0.5) * 52).toFixed(2)}px`);
  }
}

function updateScrollEffects() {
  scrollFrame = 0;
  const distance = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  progressBar?.style.setProperty("transform", `scaleX(${clamp(window.scrollY / distance)})`);
  updateHeaderTone();
  updateParallax();
  updateStackCards();
}

function requestScrollUpdate() {
  if (scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(updateScrollEffects);
}

function initReveals() {
  const items = [...document.querySelectorAll(".reveal")];
  if (!items.length) return;

  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );

  items.forEach((item) => observer.observe(item));
}

function initMenu() {
  const menu = document.querySelector("[data-mobile-menu]");
  const openButton = document.querySelector("[data-menu-button]");
  const closeButton = document.querySelector("[data-menu-close]");
  if (!menu || !openButton || !closeButton) return;

  let previousFocus = null;
  const setOpen = (open, restoreFocus = true) => {
    menu.classList.toggle("is-open", open);
    menu.setAttribute("aria-hidden", String(!open));
    openButton.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("menu-open", open);
    if (open) {
      previousFocus = document.activeElement;
      closeButton.focus();
    } else if (restoreFocus && previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
  };

  openButton.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));
  menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setOpen(false, false)));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.classList.contains("is-open")) setOpen(false);
  });
}

function initCaseRail() {
  const rail = document.querySelector("[data-case-rail]");
  const cards = [...document.querySelectorAll("[data-case-card]")];
  const previous = document.querySelector("[data-case-prev]");
  const next = document.querySelector("[data-case-next]");
  const current = document.querySelector("[data-case-current]");
  if (!rail || !cards.length || !previous || !next || !current) return;

  let index = 0;
  let pointerId = null;
  let startX = 0;
  let startScroll = 0;
  let moved = false;
  let railFrame = 0;

  const setIndex = (value, shouldScroll = true) => {
    index = (value + cards.length) % cards.length;
    current.textContent = String(index + 1);
    cards.forEach((card, cardIndex) => card.toggleAttribute("aria-current", cardIndex === index));
    if (shouldScroll) cards[index].scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", inline: "start", block: "nearest" });
  };

  const syncIndex = () => {
    railFrame = 0;
    const railLeft = rail.getBoundingClientRect().left;
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    cards.forEach((card, cardIndex) => {
      const distance = Math.abs(card.getBoundingClientRect().left - railLeft);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = cardIndex;
      }
    });
    if (closestIndex !== index) setIndex(closestIndex, false);
  };

  previous.addEventListener("click", () => setIndex(index - 1));
  next.addEventListener("click", () => setIndex(index + 1));
  rail.addEventListener("scroll", () => {
    if (!railFrame) railFrame = window.requestAnimationFrame(syncIndex);
  }, { passive: true });

  rail.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setIndex(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setIndex(index - 1);
    }
  });

  rail.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("a, button")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startScroll = rail.scrollLeft;
    moved = false;
    rail.classList.add("is-dragging");
    rail.setPointerCapture(pointerId);
  });

  rail.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const delta = event.clientX - startX;
    if (Math.abs(delta) > 5) moved = true;
    rail.scrollLeft = startScroll - delta;
  });

  const stopDragging = (event) => {
    if (pointerId !== event.pointerId) return;
    rail.classList.remove("is-dragging");
    if (rail.hasPointerCapture(pointerId)) rail.releasePointerCapture(pointerId);
    pointerId = null;
    if (moved) window.requestAnimationFrame(syncIndex);
  };

  rail.addEventListener("pointerup", stopDragging);
  rail.addEventListener("pointercancel", stopDragging);
  setIndex(0, false);
}

function initPrinciples() {
  const text = document.querySelector("[data-principle-text]");
  const current = document.querySelector("[data-principle-current]");
  const previous = document.querySelector("[data-principle-prev]");
  const next = document.querySelector("[data-principle-next]");
  const context = document.querySelector(".principle-source span");
  if (!text || !current || !previous || !next || !context) return;

  const principles = [
    {
      text: "One verified link. One person at the door. One host in control.",
      context: "Host-owned collaboration",
    },
    {
      text: "The room disappears when the host closes it. The project does not.",
      context: "Temporary public access",
    },
    {
      text: "AI can suggest the change. Only you decide whether it lands.",
      context: "Review before writes",
    },
  ];
  let index = 0;
  let timer = 0;

  const render = (nextIndex) => {
    index = (nextIndex + principles.length) % principles.length;
    const apply = () => {
      text.textContent = principles[index].text;
      context.textContent = principles[index].context;
      current.textContent = String(index + 1);
      text.classList.remove("is-changing");
    };

    window.clearTimeout(timer);
    if (reducedMotion.matches) {
      apply();
      return;
    }
    text.classList.add("is-changing");
    timer = window.setTimeout(apply, 170);
  };

  previous.addEventListener("click", () => render(index - 1));
  next.addEventListener("click", () => render(index + 1));
}

function initTilt() {
  if (reducedMotion.matches || !finePointer.matches) return;
  document.querySelectorAll("[data-tilt]").forEach((card) => {
    const baseRotation = card.classList.contains("download-card-lime") ? -3 : 2;
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      card.style.transform = `rotateZ(${baseRotation}deg) rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg)`;
    });
    card.addEventListener("pointerleave", () => {
      card.style.transform = `rotateZ(${baseRotation}deg) rotateX(0deg) rotateY(0deg)`;
    });
  });
}

function initSmoothScroll() {
  if (reducedMotion.matches || typeof window.Lenis !== "function") return null;

  const lenis = new window.Lenis({
    duration: 1.12,
    lerp: 0.1,
    smoothWheel: true,
    smoothTouch: false,
    wheelMultiplier: 0.92,
    touchMultiplier: 1.25,
    normalizeWheel: true,
    anchors: { offset: -70, duration: 1 },
  });

  let frame = 0;
  let activeUntil = 0;
  const animate = (time) => {
    frame = 0;
    lenis.raf(time);
    requestScrollUpdate();
    if (time < activeUntil || lenis.isScrolling === "smooth") frame = window.requestAnimationFrame(animate);
  };
  const start = () => {
    activeUntil = performance.now() + 1800;
    if (!frame) frame = window.requestAnimationFrame(animate);
  };

  lenis.on("virtual-scroll", start);
  lenis.on("scroll", requestScrollUpdate);
  document.addEventListener("click", (event) => {
    if (event.target.closest('a[href^="#"]')) start();
  });
  window.addEventListener("wheel", start, { passive: true });
  return lenis;
}

initReveals();
initMenu();
initCaseRail();
initPrinciples();
initTilt();
const lenis = initSmoothScroll();

window.addEventListener("scroll", requestScrollUpdate, { passive: true });
window.addEventListener("resize", () => {
  lenis?.resize?.();
  requestScrollUpdate();
});
window.addEventListener("load", requestScrollUpdate, { once: true });
reducedMotion.addEventListener?.("change", requestScrollUpdate);

requestScrollUpdate();
