const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const { app, BrowserWindow } = require("electron");
const { createLocalLeafServer } = require("../../src/server/index");
const { createDeterministicPdf } = require("../helpers/rendered-smoke-fixture");

const SMOKE_TIMEOUT_MS = 60_000;
const CONDITION_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 40;

let hostServer = null;
let smokeWindow = null;
let tempRoot = "";
let hostToken = "";
let finishing = false;
let hardTimeout = null;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value) {
  let message = String(value?.stack || value?.message || value || "Unknown rendered smoke failure");
  if (hostToken) message = message.split(hostToken).join("[host capability redacted]");
  if (tempRoot) message = message.split(tempRoot).join("[temporary fixture]");
  return message;
}

function pass(label) {
  process.stdout.write(`[rendered-smoke] PASS ${label}\n`);
}

async function rendererValue(expression) {
  ensure(smokeWindow && !smokeWindow.isDestroyed(), "The rendered smoke window closed unexpectedly.");
  return smokeWindow.webContents.executeJavaScript(`(${expression})`, true);
}

async function waitForRenderer(expression, label, timeoutMs = CONDITION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await rendererValue(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms.${lastError ? ` ${redact(lastError.message)}` : ""}`);
}

async function hostRequest(baseUrl, route, options = {}) {
  const response = await fetch(new URL(route, baseUrl), {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "x-localleaf-host-token": hostToken
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json();
  ensure(response.ok, `Host request failed with HTTP ${response.status}.`);
  return payload;
}

function installReadyProviderFixture(modelRoot) {
  const storageRoot = path.join(modelRoot, "LocalLeafModel");
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, "providers.json"),
    JSON.stringify({
      version: 1,
      activeProviderId: "opencode-go",
      activeLocalModelId: null,
      providers: [
        {
          id: "opencode-go",
          hasApiKey: false,
          status: "ready",
          test: {
            ok: true,
            status: "ready",
            color: "green",
            message: "Connection ready.",
            providerId: "opencode-go",
            modelId: "kimi-k2.5"
          }
        }
      ]
    }),
    "utf8"
  );
}

async function installRendererErrorCapture() {
  await rendererValue(`(() => {
    window.__localLeafRenderedSmokeErrors = [];
    window.addEventListener("error", (event) => {
      window.__localLeafRenderedSmokeErrors.push(String(event.message || "renderer error"));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__localLeafRenderedSmokeErrors.push(String(event.reason?.message || event.reason || "unhandled rejection"));
    });
    return true;
  })()`);
}

async function dispatchTrustedSpaceKey() {
  const debuggerApi = smokeWindow.webContents.debugger;
  let attachedHere = false;
  if (!debuggerApi.isAttached()) {
    debuggerApi.attach("1.3");
    attachedHere = true;
  }
  try {
    const key = {
      key: " ",
      code: "Space",
      text: " ",
      unmodifiedText: " ",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32
    };
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function dispatchTrustedArrowKey(direction) {
  const debuggerApi = smokeWindow.webContents.debugger;
  const isDown = direction === "down";
  const key = isDown ? "ArrowDown" : "ArrowUp";
  const virtualKeyCode = isDown ? 40 : 38;
  let attachedHere = false;
  if (!debuggerApi.isAttached()) {
    debuggerApi.attach("1.3");
    attachedHere = true;
  }
  try {
    const input = {
      key,
      code: key,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode
    };
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...input });
    await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...input });
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function moveTrustedPointerTo(selector) {
  const point = await rendererValue(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const rect = target?.getBoundingClientRect();
    return rect ? { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) } : null;
  })()`);
  ensure(point, `Could not locate ${selector} for rendered pointer input.`);
  const debuggerApi = smokeWindow.webContents.debugger;
  let attachedHere = false;
  if (!debuggerApi.isAttached()) {
    debuggerApi.attach("1.3");
    attachedHere = true;
  }
  try {
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      pointerType: "mouse"
    });
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function setEmulatedMediaFeatures(features = []) {
  const debuggerApi = smokeWindow.webContents.debugger;
  if (!debuggerApi.isAttached()) {
    debuggerApi.attach("1.3");
  }
  try {
    await debuggerApi.sendCommand("Emulation.setEmulatedMedia", {
      media: "",
      features
    });
  } finally {
    if (!features.length && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function testHostStartupAndHelp(baseUrl) {
  await smokeWindow.loadURL(`${baseUrl}/?host=${encodeURIComponent(hostToken)}`);
  await installRendererErrorCapture();
  smokeWindow.setContentSize(1024, 640);
  await waitForRenderer(
    `innerWidth === 1024 && innerHeight === 640`,
    "the initial 1024x640 content viewport"
  );
  await waitForRenderer(
    `(() => Boolean(document.querySelector("#railHelp")) && !document.querySelector(".app-error") && !document.body.textContent.includes("LocalLeaf failed to start"))()`,
    "the host-authenticated Home screen"
  );

  const identity = await rendererValue(`(() => ({
    title: document.title,
    capabilityStored: Boolean(sessionStorage.getItem("localleaf.hostToken")),
    capabilityHidden: !new URLSearchParams(location.search).has("host") && !new URLSearchParams(location.search).has("hostToken")
  }))()`);
  ensure(identity.title === "LocalLeaf Host", "The renderer loaded an unexpected document title.");
  ensure(identity.capabilityStored && identity.capabilityHidden, "Host authentication did not initialize or hide its capability from the visible URL.");
  pass("host-authenticated app startup");

  await rendererValue(`(() => {
    const button = document.querySelector("#newProject");
    button?.focus();
    button?.click();
    return Boolean(button);
  })()`);
  await waitForRenderer(
    `Boolean(document.querySelector(".new-project-modal"))`,
    "the New Project dialog"
  );
  const newProjectDialog = await rendererValue(`(() => {
    const dialog = document.querySelector(".new-project-modal");
    const name = document.querySelector("#newProjectName");
    const destination = document.querySelector("#newProjectDestination");
    const create = document.querySelector("#createNewProject");
    const scrolling = document.scrollingElement;
    return {
      role: dialog?.getAttribute("role") || "",
      modal: dialog?.getAttribute("aria-modal") || "",
      labelledBy: dialog?.getAttribute("aria-labelledby") || "",
      focusedControl: document.activeElement?.id || "",
      name: name?.value || "",
      destination: destination?.value || "",
      destinationEditable: Boolean(destination) && !destination.readOnly && !destination.disabled,
      hasBrowse: Boolean(document.querySelector("#browseNewProjectDestination")),
      hasCancel: Boolean(document.querySelector("#cancelNewProject")),
      createBackground: create ? getComputedStyle(create).backgroundColor : "",
      createColor: create ? getComputedStyle(create).color : "",
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
    };
  })()`);
  ensure(
    newProjectDialog.role === "dialog"
      && newProjectDialog.modal === "true"
      && newProjectDialog.labelledBy === "newProjectTitle"
      && newProjectDialog.focusedControl === "newProjectName"
      && newProjectDialog.name === "LocalLeaf Project"
      && newProjectDialog.destination
      && newProjectDialog.destinationEditable
      && newProjectDialog.hasBrowse
      && newProjectDialog.hasCancel,
    `The New Project dialog is missing its accessible, editable creation controls: ${JSON.stringify(newProjectDialog)}`
  );
  ensure(
    newProjectDialog.createBackground === "rgb(201, 81, 0)"
      && newProjectDialog.createColor === "rgb(255, 255, 255)"
      && !newProjectDialog.outerOverflowX
      && !newProjectDialog.outerOverflowY,
    `The New Project dialog drifted from the primary-action or viewport contract: ${JSON.stringify(newProjectDialog)}`
  );
  await rendererValue(`document.querySelector("#browseNewProjectDestination")?.click()`);
  await waitForRenderer(
    `document.querySelector("#newProjectStatus")?.textContent?.includes("enter the destination path")`,
    "the editable-path fallback when a native folder picker is unavailable"
  );
  await rendererValue(`document.querySelector(".new-project-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await waitForRenderer(
    `!document.querySelector(".new-project-backdrop") && document.activeElement?.id === "newProject"`,
    "New Project dialog focus restoration"
  );
  pass("New Project is an accessible centered form with an editable destination fallback");

  await rendererValue(`(() => {
    document.querySelector("#railSettings")?.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => {
      if (document.querySelector(".settings-preferences-modal")) return true;
      document.querySelector("#railSettings")?.click();
      return false;
    })()`,
    "the Settings dialog"
  );
  await rendererValue(`(() => {
    document.querySelector('#settingsTab-providers')?.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => Boolean(document.querySelector('#settingsPanel-providers:not([hidden]) .provider-test-result.green')))()`,
    "the connected-provider status badge"
  );
  const providerStatusStyle = await rendererValue(`(() => {
    const badge = document.querySelector('#settingsPanel-providers:not([hidden]) .provider-test-result.green');
    const row = badge?.closest('.provider-row');
    const modal = badge?.closest('.settings-preferences-modal');
    const metadataTag = row?.querySelector('.settings-status-tag');
    const badgeStyle = badge && getComputedStyle(badge);
    const metadataStyle = metadataTag && getComputedStyle(metadataTag);
    const badgeRect = badge?.getBoundingClientRect();
    const metadataRect = metadataTag?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const modalRect = modal?.getBoundingClientRect();
    const scrolling = document.scrollingElement;
    return {
      text: badge?.textContent?.trim() || '',
      fontSize: badgeStyle?.fontSize || '',
      lineHeight: badgeStyle?.lineHeight || '',
      height: badgeRect?.height || 0,
      metadataFontSize: metadataStyle?.fontSize || '',
      metadataLineHeight: metadataStyle?.lineHeight || '',
      metadataHeight: metadataRect?.height || 0,
      metadataOverflow: Boolean(metadataTag)
        && (metadataTag.scrollWidth > metadataTag.clientWidth + 1 || metadataTag.scrollHeight > metadataTag.clientHeight + 1),
      badgeOverflow: Boolean(badge) && (badge.scrollWidth > badge.clientWidth + 1 || badge.scrollHeight > badge.clientHeight + 1),
      rowOverflowX: Boolean(row) && row.scrollWidth > row.clientWidth + 1,
      badgeInsideRow: Boolean(badgeRect && rowRect)
        && badgeRect.left >= rowRect.left - 1
        && badgeRect.right <= rowRect.right + 1
        && badgeRect.top >= rowRect.top - 1
        && badgeRect.bottom <= rowRect.bottom + 1,
      modalInsideViewport: Boolean(modalRect)
        && modalRect.left >= -1
        && modalRect.top >= -1
        && modalRect.right <= innerWidth + 1
        && modalRect.bottom <= innerHeight + 1,
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1,
      width: innerWidth,
      viewportHeight: innerHeight
    };
  })()`);
  ensure(
    providerStatusStyle
      && providerStatusStyle.text === "Connection ready."
      && providerStatusStyle.fontSize === "11px"
      && providerStatusStyle.lineHeight === "16px"
      && providerStatusStyle.height === 20
      && providerStatusStyle.metadataFontSize === "11px"
      && providerStatusStyle.metadataLineHeight === "16px"
      && providerStatusStyle.metadataHeight === 20,
    `The connected-provider status badge drifted from its compact 11px metadata scale: ${JSON.stringify(providerStatusStyle)}`
  );
  ensure(
    providerStatusStyle.width === 1024
      && providerStatusStyle.viewportHeight === 640
      && !providerStatusStyle.badgeOverflow
      && !providerStatusStyle.metadataOverflow
      && !providerStatusStyle.rowOverflowX
      && providerStatusStyle.badgeInsideRow
      && providerStatusStyle.modalInsideViewport
      && !providerStatusStyle.outerOverflowX
      && !providerStatusStyle.outerOverflowY,
    `The connected-provider status badge or Settings dialog overflowed the supported 1024x640 viewport: ${JSON.stringify(providerStatusStyle)}`
  );
  pass("provider connection status stays compact and contained at 1024x640");
  await rendererValue(`(() => {
    document.querySelector('[data-close-settings]')?.click();
    return true;
  })()`);

  await rendererValue(`(() => {
    document.querySelector("#railSession")?.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => {
      const button = document.querySelector("#railSession.active");
      if (!button) return false;
      const underline = getComputedStyle(button, "::after");
      return underline.opacity === "1" && underline.transform !== "none" && !underline.transform.includes("(0,");
    })()`,
    "the underline-only active Session navigation state"
  );
  const sessionNavigationStyle = await rendererValue(`(() => {
    const button = document.querySelector("#railSession.active");
    const style = getComputedStyle(button);
    const underline = getComputedStyle(button, "::after");
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      color: style.color,
      underline: underline.backgroundColor,
      underlineOpacity: underline.opacity
    };
  })()`);
  ensure(
    sessionNavigationStyle
      && sessionNavigationStyle.background === "rgba(0, 0, 0, 0)"
      && sessionNavigationStyle.border === "rgba(0, 0, 0, 0)"
      && sessionNavigationStyle.color === "rgb(24, 24, 24)"
      && sessionNavigationStyle.underline === "rgb(201, 81, 0)"
      && sessionNavigationStyle.underlineOpacity === "1",
    "The active Session navigation item did not keep a neutral underline-only selected state."
  );
  pass("active Session navigation uses only the accessible orange underline");

  await waitForRenderer(
    `(() => {
      if (document.querySelectorAll(".help-qa-list details").length === 4) return true;
      document.querySelector("#railHelp")?.click();
      return false;
    })()`,
    "the Help disclosures"
  );

  const mouseResult = await rendererValue(`(() => {
    const details = document.querySelectorAll(".help-qa-list details")[1];
    const summary = details?.querySelector("summary");
    if (!summary) return null;
    const before = details.open;
    summary.click();
    return {
      before,
      after: details.open,
      expandedLabel: getComputedStyle(details.querySelector(".help-disclosure-label-expanded")).display !== "none"
    };
  })()`);
  ensure(mouseResult && !mouseResult.before && mouseResult.after && mouseResult.expandedLabel, "A Help disclosure did not open with mouse activation or expose its expanded label.");

  smokeWindow.show();
  smokeWindow.focus();
  smokeWindow.webContents.focus();
  await waitForRenderer(`document.hasFocus()`, "the keyboard test window focus");
  const keyboardFocused = await rendererValue(`(() => {
    const summary = document.querySelectorAll(".help-qa-list details")[2]?.querySelector("summary");
    summary?.focus();
    return document.activeElement === summary;
  })()`);
  ensure(keyboardFocused, "The Help disclosure summary could not receive keyboard focus.");
  await dispatchTrustedSpaceKey();
  await waitForRenderer(`document.querySelectorAll(".help-qa-list details")[2]?.open === true`, "keyboard disclosure activation");
  pass("Help disclosures respond to mouse and keyboard input");

  await rendererValue(`(() => {
    document.querySelector("[data-close-info]")?.click();
    document.querySelector("#railAbout")?.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => Boolean(document.querySelector(".info-modal-about .about-editorial")))()`,
    "the About LocalLeaf editorial view"
  );
  const aboutResult = await rendererValue(`(() => {
    const body = document.querySelector(".info-modal-about .about-editorial");
    const website = body?.querySelector(".about-website-link");
    return {
      product: body?.querySelector(".about-product-name")?.textContent?.trim() || "",
      principles: Array.from(body?.querySelectorAll(".about-values span") || []).map((item) => item.textContent.trim()),
      details: Array.from(body?.querySelectorAll(".about-detail dt") || []).map((item) => item.textContent.trim()),
      decorativeIcons: body?.querySelectorAll("svg, .ui-glyph, .brand-symbol").length || 0,
      websiteLabel: website?.textContent?.trim() || "",
      websiteUrl: website?.href || "",
      websiteBackground: website ? getComputedStyle(website).backgroundColor : "",
      websiteColor: website ? getComputedStyle(website).color : "",
      closeLabel: document.querySelector(".info-modal-about [data-close-info]")?.getAttribute("aria-label") || ""
    };
  })()`);
  ensure(
    aboutResult.product === "LocalLeaf"
      && aboutResult.principles.join("|") === "Private by design|Host powered"
      && aboutResult.details.join("|") === "Local files|Approved guests|Host compile|Project chat",
    "The About view is missing its product principles or core collaboration details."
  );
  ensure(aboutResult.decorativeIcons === 0, "The About content reintroduced decorative icons.");
  ensure(aboutResult.websiteLabel === "Visit website" && /^https:\/\//.test(aboutResult.websiteUrl), "The About website action is missing or unsafe.");
  ensure(
    aboutResult.websiteBackground === "rgb(201, 81, 0)" && aboutResult.websiteColor === "rgb(255, 255, 255)",
    "The About website action drifted from the accessible orange-and-white primary action contract."
  );
  ensure(aboutResult.closeLabel === "Close", "The About dialog close action lost its accessible name.");
  pass("About view is icon-free, complete, and accessible");

  await rendererValue(`(() => {
    document.querySelector("[data-close-info]")?.click();
    document.querySelector("#railSettings")?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector("#themeModeSwitch"))`, "the Appearance theme switch");

  const initialThemeSwitch = await rendererValue(`(() => {
    const control = document.querySelector("#themeModeSwitch");
    const thumb = control?.querySelector(".settings-theme-thumb");
    const icons = Array.from(control?.querySelectorAll(".settings-theme-icon") || []);
    const controlStyle = control ? getComputedStyle(control) : null;
    const thumbStyle = thumb ? getComputedStyle(thumb) : null;
    return control && thumb && icons.length === 2 ? {
      checked: control.getAttribute("aria-checked"),
      role: control.getAttribute("role"),
      label: control.getAttribute("aria-label"),
      title: control.getAttribute("title"),
      width: controlStyle.width,
      height: controlStyle.height,
      thumbWidth: thumbStyle.width,
      thumbHeight: thumbStyle.height,
      thumbTransform: thumbStyle.transform,
      thumbTransition: thumbStyle.transitionProperty,
      iconNames: icons.map((icon) => icon.dataset.themeIcon),
      iconSizes: icons.map((icon) => [getComputedStyle(icon).width, getComputedStyle(icon).height]),
      iconStrokes: icons.map((icon) => getComputedStyle(icon).strokeWidth),
      iconTransitions: icons.map((icon) => getComputedStyle(icon).transitionProperty),
      decorative: icons.every((icon) => icon.getAttribute("aria-hidden") === "true" && icon.getAttribute("focusable") === "false")
    } : null;
  })()`);
  ensure(initialThemeSwitch, "The Appearance switch did not render both theme glyphs.");
  ensure(
    initialThemeSwitch.role === "switch"
      && initialThemeSwitch.label === "Dark mode"
      && ["true", "false"].includes(initialThemeSwitch.checked)
      && initialThemeSwitch.decorative,
    "The Appearance switch lost its stable accessible switch semantics."
  );
  ensure(
    initialThemeSwitch.width === "76px"
      && initialThemeSwitch.height === "32px"
      && initialThemeSwitch.thumbWidth === "35px"
      && initialThemeSwitch.thumbHeight === "26px"
      && initialThemeSwitch.iconNames.join("|") === "sun|moon"
      && initialThemeSwitch.iconSizes.every(([width, height]) => width === "18px" && height === "18px")
      && initialThemeSwitch.iconStrokes.every((width) => width === "1.5px"),
    "The Appearance switch drifted from its compact 18px icon geometry."
  );
  ensure(
    initialThemeSwitch.thumbTransition === "transform"
      && initialThemeSwitch.iconTransitions.every((properties) => properties === "transform, opacity"),
    "The Appearance switch introduced a non-compositor motion property."
  );

  const themeSwitchFocused = await rendererValue(`(() => {
    const control = document.querySelector("#themeModeSwitch");
    control?.focus();
    return document.activeElement === control;
  })()`);
  ensure(themeSwitchFocused, "The Appearance switch could not receive keyboard focus.");
  await dispatchTrustedSpaceKey();
  const nextChecked = initialThemeSwitch.checked === "true" ? "false" : "true";
  await waitForRenderer(
    `document.querySelector("#themeModeSwitch")?.getAttribute("aria-checked") === "${nextChecked}"`,
    "keyboard theme activation"
  );
  await delay(420);
  const toggledThemeSwitch = await rendererValue(`(() => {
    const control = document.querySelector("#themeModeSwitch");
    const isDark = control?.getAttribute("aria-checked") === "true";
    const activeIcon = control?.querySelector(isDark ? ".settings-theme-moon .settings-theme-icon" : ".settings-theme-sun .settings-theme-icon");
    const inactiveIcon = control?.querySelector(isDark ? ".settings-theme-sun .settings-theme-icon" : ".settings-theme-moon .settings-theme-icon");
    return control && activeIcon && inactiveIcon ? {
      isDark,
      documentState: document.documentElement.classList.contains(isDark ? "theme-dark" : "theme-light"),
      title: control.getAttribute("title"),
      thumbTransform: getComputedStyle(control.querySelector(".settings-theme-thumb")).transform,
      activeColor: getComputedStyle(activeIcon).color,
      activeOpacity: Number.parseFloat(getComputedStyle(activeIcon).opacity),
      inactiveOpacity: Number.parseFloat(getComputedStyle(inactiveIcon).opacity)
    } : null;
  })()`);
  ensure(
    toggledThemeSwitch
      && toggledThemeSwitch.documentState
      && toggledThemeSwitch.title === (toggledThemeSwitch.isDark ? "Switch to light mode" : "Switch to dark mode")
      && toggledThemeSwitch.thumbTransform !== initialThemeSwitch.thumbTransform
      && toggledThemeSwitch.activeColor === "rgb(201, 81, 0)"
      && toggledThemeSwitch.activeOpacity > toggledThemeSwitch.inactiveOpacity,
    `The Appearance switch did not update its theme state, thumb, title, and restrained orange accent together: ${JSON.stringify(toggledThemeSwitch)}`
  );
  await rendererValue(`document.querySelector("#themeModeSwitch")?.click()`);
  await waitForRenderer(
    `document.querySelector("#themeModeSwitch")?.getAttribute("aria-checked") === "${initialThemeSwitch.checked}"`,
    "theme reset after the keyboard check"
  );
  pass("Appearance switch is compact, keyboard accessible, and compositor-safe");
}

async function loadHostView(baseUrl, view, readySelector) {
  const target = new URL(baseUrl);
  if (view) target.searchParams.set("view", view);
  target.searchParams.set("host", hostToken);
  await smokeWindow.loadURL(target.toString());
  await installRendererErrorCapture();
  await waitForRenderer(
    `Boolean(document.querySelector(${JSON.stringify(readySelector)}))`,
    `${view || "home"} parity surface`
  );
}

async function captureDesktopParity(theme, surfaceSelectors, contrastSelectors) {
  await rendererValue(`(() => { applyTheme(${JSON.stringify(theme)}); return true; })()`);
  await waitForRenderer(
    `document.documentElement.classList.contains(${JSON.stringify(`theme-${theme}`)})`,
    `${theme} theme parity state`
  );
  await delay(220);
  const expression = `(() => {
    try {
    const surfaceSelectors = ${JSON.stringify(surfaceSelectors)};
    const contrastSelectors = ${JSON.stringify(contrastSelectors)};
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const channels = (value) => {
      const values = (String(value).match(/[\\d.]+/g) || []).map(Number);
      return [values[0] || 0, values[1] || 0, values[2] || 0, values.length > 3 ? values[3] : 1];
    };
    const luminance = (value) => {
      const rgb = channels(value).slice(0, 3).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return (0.2126 * rgb[0]) + (0.7152 * rgb[1]) + (0.0722 * rgb[2]);
    };
    const contrast = (foreground, background) => {
      const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const effectiveBackground = (element) => {
      let current = element;
      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (channels(background)[3] >= 0.98) return background;
        current = current.parentElement;
      }
      return ${theme === "dark" ? '"rgb(17, 18, 16)"' : '"rgb(255, 255, 255)"'};
    };
    const label = (element) => element.id
      ? "#" + element.id
      : element.tagName.toLowerCase() + "." + String(element.className || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
    const surfaces = surfaceSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(visible)
      .map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          label: label(element),
          background: style.backgroundColor,
          image: style.backgroundImage,
          contained: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
        };
      });
    const selectedSelector = [
      ".host-rail-button.active",
      ".right-rail-tab.active",
      ".settings-tab.active",
      ".editor-mode-pill.active",
      ".editor-search-scope button.active",
      ".settings-segment button.active",
      ".editor-more-item.active",
      ".ai-model-menu button.active",
      ".ai-context-model-list > button.active",
      ".file-button.active",
      ".tree-folder-row.active",
      ".outline-row.active",
      ".editor-tool-button.active",
      ".editor-style-button.active",
      ".search-toggle.active",
      ".layout-toggle.active",
      ".project-search-result.active"
    ].join(",");
    const selectedFailures = Array.from(document.querySelectorAll(selectedSelector)).filter(visible).flatMap((element) => {
      const style = getComputedStyle(element);
      const target = element.matches(".file-button")
        ? element.querySelector(".file-label")
        : element.matches(".tree-folder-row")
          ? element.querySelector(".folder-name")
          : element.matches(".outline-row")
            ? element.querySelector(".outline-title")
            : element;
      const underline = target ? getComputedStyle(target, "::after") : null;
      const transparent = channels(style.backgroundColor)[3] === 0;
      const underlineVisible = underline && Number.parseFloat(underline.opacity) >= 0.99;
      return transparent && underlineVisible ? [] : [{
        label: label(element),
        background: style.backgroundColor,
        underlineOpacity: underline?.opacity || "missing"
      }];
    });
    const contrastFailures = contrastSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => visible(element) && !element.closest(":disabled, .provider-logo") && Number.parseFloat(getComputedStyle(element).opacity) >= 0.98)
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const ratio = contrast(style.color, effectiveBackground(element));
        return ratio >= 4.5 ? [] : [{ label: label(element), ratio: Number(ratio.toFixed(2)), color: style.color, background: effectiveBackground(element) }];
      });
    const lightLeaks = ${theme === "dark" ? `Array.from(document.querySelectorAll("body *")).filter(visible).flatMap((element) => {
      if (element.matches("canvas, option") || element.closest(".provider-logo, .pdf-page, .paper-preview, .settings-theme-thumb, .brand-symbol")) return [];
      const style = getComputedStyle(element);
      const [red, green, blue, alpha] = channels(style.backgroundColor);
      return alpha >= 0.98 && red >= 238 && green >= 238 && blue >= 238
        ? [{ label: label(element), background: style.backgroundColor }]
        : [];
    }).slice(0, 12)` : "[]"};
    const scrolling = document.scrollingElement;
    return {
      width: innerWidth,
      height: innerHeight,
      surfaces,
      selectedFailures,
      contrastFailures,
      lightLeaks,
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
    };
    } catch (error) {
      return { auditError: String(error?.stack || error?.message || error) };
    }
  })()`;
  try {
    Function(`return (${expression});`);
  } catch (error) {
    throw new Error(`Desktop parity expression is invalid: ${error.message}`);
  }
  return rendererValue(expression);
}

async function verifyCurrentThemePair(label, surfaceSelectors, contrastSelectors) {
  await waitForRenderer(
    `(() => Array.from(document.querySelectorAll(".settings-tab.active")).every((tab) => Number.parseFloat(getComputedStyle(tab, "::after").opacity) >= 0.99))()`,
    `${label} selected underline settling`
  );
  for (const theme of ["light", "dark"]) {
    process.stdout.write(`[rendered-smoke] AUDIT ${label} ${theme}\n`);
    const result = await captureDesktopParity(theme, surfaceSelectors, [
      ".btn-primary:not(:disabled)",
      ".compile-button:not(:disabled)",
      ...contrastSelectors
    ]);
    ensure(!result.auditError, `${label} ${theme} parity audit failed: ${result.auditError}`);
    ensure(result.surfaces.length >= surfaceSelectors.length, `${label} did not expose every expected ${theme} surface.`);
    ensure(result.surfaces.every((surface) => surface.image === "none"), `${label} retained a gradient in the ${result.width}x${result.height} ${theme} viewport: ${JSON.stringify(result.surfaces)}`);
    ensure(!result.outerOverflowX && !result.outerOverflowY, `${label} introduced outer scrolling at ${result.width}x${result.height} in ${theme} mode.`);
    ensure(result.selectedFailures.length === 0, `${label} retained a filled selected tile or lost its underline in ${theme} mode: ${JSON.stringify(result.selectedFailures)}`);
    ensure(result.contrastFailures.length === 0, `${label} contains sub-AA text in ${theme} mode: ${JSON.stringify(result.contrastFailures)}`);
    ensure(result.lightLeaks.length === 0, `${label} leaked a light surface into dark mode: ${JSON.stringify(result.lightLeaks)}`);
  }
}

async function testDesktopThemeParity(baseUrl) {
  for (const [width, height] of [[1024, 640], [1440, 900]]) {
    smokeWindow.setContentSize(width, height);
    await waitForRenderer(`innerWidth === ${width} && innerHeight === ${height}`, `${width}x${height} content viewport`);

    await loadHostView(baseUrl, "", ".home-app-page");
    await verifyCurrentThemePair("Home", [".titlebar", ".host-nav-rail", ".window-content", ".home-actions-panel", ".home-current-panel", ".current-project-card"], [".section-title", ".current-project-card p", ".current-project-card > span"]);

    await rendererValue(`document.querySelector("#railSettings")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".settings-preferences-modal"))`, "Settings parity dialog");
    for (const tab of ["general", "providers", "models", "permissions"]) {
      await rendererValue(`document.querySelector(${JSON.stringify(`#settingsTab-${tab}`)})?.click()`);
      await waitForRenderer(`Boolean(document.querySelector(${JSON.stringify(`#settingsPanel-${tab}:not([hidden])`)}))`, `${tab} Settings parity panel`);
      await verifyCurrentThemePair(`Settings ${tab}`, [".settings-preferences-modal", ".settings-modal-head", ".settings-options", `#settingsPanel-${tab}:not([hidden]) .settings-list-card, #settingsPanel-${tab}:not([hidden]) .settings-section-intro, #settingsPanel-${tab}:not([hidden]) .settings-general-hero`], [".settings-modal-head p", `#settingsPanel-${tab}:not([hidden]) .settings-list-main span`, `#settingsPanel-${tab}:not([hidden]) .settings-model-heading`]);
    }
    await rendererValue(`document.querySelector("[data-close-settings]")?.click()`);
    await waitForRenderer(`!document.querySelector(".settings-preferences-modal")`, "Settings parity dialog closing");
    await rendererValue(`document.querySelector("#railHelp")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".help-qa-list"))`, "Help parity dialog");
    await verifyCurrentThemePair("Help", [".info-modal", ".info-modal .settings-modal-head", ".info-modal-body", ".help-qa-list details:first-child"], [".settings-modal-head p", ".help-qa-list summary .help-step", ".help-qa-list summary strong"]);
    await rendererValue(`document.querySelector("[data-close-info]")?.click()`);
    await waitForRenderer(`!document.querySelector(".info-modal")`, "Help parity dialog closing");
    await rendererValue(`document.querySelector("#railAbout")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".about-editorial"))`, "About parity dialog");
    await verifyCurrentThemePair("About", [".info-modal", ".info-modal .settings-modal-head", ".about-editorial", ".about-detail-list"], [".settings-modal-head p", ".about-summary", ".about-detail dt", ".about-detail dd"]);

    await loadHostView(baseUrl, "project", ".project-app-page");
    await verifyCurrentThemePair("Project", [".titlebar", ".host-nav-rail", ".window-content", ".project-primary-panel", ".project-details-panel", ".status-list"], [".project-app-head p", ".section-title", ".status-warn", ".project-detail-list span"]);
    const projectPlacement = await rendererValue(`(() => {
      const content = document.querySelector(".window-content")?.getBoundingClientRect();
      const page = document.querySelector(".project-app-page")?.getBoundingClientRect();
      const scrolling = document.scrollingElement;
      return content && page ? {
        horizontalOffset: Math.abs((page.left + (page.width / 2)) - (content.left + (content.width / 2))),
        verticalOffset: Math.abs((page.top + (page.height / 2)) - (content.top + (content.height / 2))),
        pageInsideContent: page.top >= content.top - 1 && page.bottom <= content.bottom + 1,
        outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
        outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
      } : null;
    })()`);
    ensure(
      projectPlacement
        && projectPlacement.horizontalOffset <= 1
        && projectPlacement.verticalOffset <= 1
        && projectPlacement.pageInsideContent
        && !projectPlacement.outerOverflowX
        && !projectPlacement.outerOverflowY,
      `Project Overview is not centered and contained at ${width}x${height}: ${JSON.stringify(projectPlacement)}`
    );

    await loadHostView(baseUrl, "session", ".session-share-page");
    await verifyCurrentThemePair("Session", [".titlebar", ".host-nav-rail", ".window-content", ".session-invite-panel", ".session-side-card", ".session-empty-panel"], [".session-panel-title", ".session-empty-panel span", ".session-provider-hint", ".pill-warn"]);

    await loadHostView(baseUrl, "editor", ".editor-shell");
    await verifyCurrentThemePair("Editor", [".editor-shell", ".editor-topbar", ".editor-format-row", ".sidebar", ".code-panel", ".preview-panel", ".right-rail", ".log-dock"], [".editor-help", ".folder-count", ".user-row .avatar", ".chat-empty"]);
    await rendererValue(`document.querySelector("#editorMoreButton")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".editor-more-menu"))`, "workspace-menu parity surface");
    await verifyCurrentThemePair("Workspace menu", [".editor-more-menu", ".editor-more-section"], [".editor-more-section-title", ".editor-menu-state", ".editor-more-update small"]);
  }

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await waitForRenderer(
    `matchMedia("(prefers-reduced-motion: reduce)").matches`,
    "the reduced-motion media override"
  );
  const reducedMotion = await rendererValue(`(() => ({
    active: matchMedia("(prefers-reduced-motion: reduce)").matches,
    underlineDuration: getComputedStyle(document.querySelector(".file-button.active .file-label"), "::after").transitionDuration
  }))()`);
  ensure(reducedMotion.active && reducedMotion.underlineDuration === "0s", `Reduced motion did not remove the selected-row transition: ${JSON.stringify(reducedMotion)}`);

  await setEmulatedMediaFeatures([{ name: "forced-colors", value: "active" }]);
  await waitForRenderer(
    `matchMedia("(forced-colors: active)").matches`,
    "the forced-colors media override"
  );
  const forcedColors = await rendererValue(`(() => ({
    active: matchMedia("(forced-colors: active)").matches,
    avatarBorder: getComputedStyle(document.querySelector(".user-row .avatar")).borderStyle,
    selectedBackground: getComputedStyle(document.querySelector(".file-button.active")).backgroundColor
  }))()`);
  ensure(forcedColors.active && forcedColors.avatarBorder === "solid" && forcedColors.selectedBackground === "rgba(0, 0, 0, 0)", `Forced colors lost avatar structure or underline-only selection: ${JSON.stringify(forcedColors)}`);
  await setEmulatedMediaFeatures([]);

  smokeWindow.setContentSize(1024, 640);
  await rendererValue(`(() => { applyTheme("light"); return true; })()`);
  await waitForRenderer(`innerWidth === 1024 && innerHeight === 640`, "parity viewport reset");
  pass("desktop Home, Project, Session, Editor, Settings, Help, About, and menus keep light/dark parity at 1024x640 and 1440x900");
}

async function testChatPresentation() {
  const richReply = [
    "## Summary",
    "",
    "Updated **main.tex** with a clearer *opening*.",
    "",
    "- Kept the existing structure",
    "- Tightened the introduction",
    "",
    "> Review the wording before applying the edit.",
    "",
    "Use `\\section{Introduction}` for the heading.",
    "",
    "```latex",
    "\\section{Introduction}",
    "```",
    "",
    "[Read the guide](https://example.com/localleaf-guide)"
  ].join("\n");

  await rendererValue(`(() => {
    window.__localLeafRenderedSmokeChatState = {
      chat: local.appState.chat,
      aiMessages: local.aiMessages,
      aiActivityMessage: local.aiActivityMessage,
      rightRailTab: local.rightRailTab,
      theme: local.theme
    };
    local.appState.chat = [
      { author: local.userName, message: "Let's review the opening together.", createdAt: 1735689600000 },
      { author: "Mira", message: "I added a shorter first paragraph.", createdAt: 1735689660000 }
    ];
    local.aiMessages = [
      { id: "rendered-user-message", role: "user", message: "Please **tighten** the introduction." },
      { id: "rendered-assistant-message", role: "assistant", message: ${JSON.stringify(richReply)}, fileLinks: ["main.tex"] }
    ];
    local.aiActivityMessage = "";
    applyTheme("light");
    setRightRailTab("chat");
    return true;
  })()`);
  await waitForRenderer(
    `document.querySelectorAll(".chat-list .chat-message").length === 2`,
    "the light human-chat fixture"
  );

  async function captureHumanChat(theme) {
    await rendererValue(`(() => { applyTheme(${JSON.stringify(theme)}); setRightRailTab("chat"); return true; })()`);
    await waitForRenderer(
      `document.documentElement.classList.contains("theme-${theme}") && document.querySelectorAll(".chat-list .chat-message").length === 2`,
      `${theme} human-chat presentation`
    );
    return rendererValue(`(() => {
      const colorParts = (value) => (String(value).match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = colorParts(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
      };
      const contrast = (foreground, background) => {
        const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const list = document.querySelector(".chat-list");
      const panel = document.querySelector(".chat-panel");
      const ownMessage = list?.querySelector(".chat-message.own");
      const guestMessage = list?.querySelector(".chat-message:not(.own)");
      const ownBubble = ownMessage?.querySelector(".chat-bubble");
      const guestBubble = guestMessage?.querySelector(".chat-bubble");
      const ownText = ownBubble?.querySelector("p");
      const guestText = guestBubble?.querySelector("p");
      const metadata = guestMessage?.querySelector(".chat-meta strong");
      const listStyle = list && getComputedStyle(list);
      const ownStyle = ownBubble && getComputedStyle(ownBubble);
      const guestStyle = guestBubble && getComputedStyle(guestBubble);
      const ownTextStyle = ownText && getComputedStyle(ownText);
      const guestTextStyle = guestText && getComputedStyle(guestText);
      const metadataStyle = metadata && getComputedStyle(metadata);
      const listRect = list?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const scrolling = document.scrollingElement;
      return {
        articles: Array.from(list?.querySelectorAll(".chat-message") || []).every((message) =>
          message.tagName === "ARTICLE" && /^Message from /.test(message.getAttribute("aria-label") || "")
        ),
        listBackground: listStyle?.backgroundColor || "",
        listOverflowY: listStyle?.overflowY || "",
        ownBackground: ownStyle?.backgroundColor || "",
        ownShadow: ownStyle?.boxShadow || "",
        guestBackground: guestStyle?.backgroundColor || "",
        guestBorderLeft: guestStyle?.borderLeftColor || "",
        guestShadow: guestStyle?.boxShadow || "",
        bodyFontSize: guestTextStyle?.fontSize || "",
        bodyLineHeight: guestTextStyle?.lineHeight || "",
        metadataFontSize: metadataStyle?.fontSize || "",
        metadataLineHeight: metadataStyle?.lineHeight || "",
        ownContrast: contrast(ownTextStyle?.color || "rgb(0, 0, 0)", ownStyle?.backgroundColor || "rgb(255, 255, 255)"),
        guestContrast: contrast(guestTextStyle?.color || "rgb(0, 0, 0)", listStyle?.backgroundColor || "rgb(255, 255, 255)"),
        contained: Boolean(listRect && panelRect)
          && listRect.left >= panelRect.left - 1
          && listRect.right <= panelRect.right + 1
          && listRect.top >= panelRect.top - 1
          && listRect.bottom <= panelRect.bottom + 1,
        outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
        outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
      };
    })()`);
  }

  const lightChat = await captureHumanChat("light");
  const darkChat = await captureHumanChat("dark");
  ensure(
    lightChat.articles
      && lightChat.listBackground === "rgb(255, 255, 255)"
      && lightChat.ownBackground === "rgb(247, 246, 243)"
      && lightChat.guestBackground === "rgba(0, 0, 0, 0)"
      && lightChat.guestBorderLeft === "rgb(201, 81, 0)"
      && lightChat.ownShadow === "none"
      && lightChat.guestShadow === "none",
    `The light human Chat regained a tinted slab, shadow, or lost its editorial source cue: ${JSON.stringify(lightChat)}`
  );
  ensure(
    darkChat.articles
      && darkChat.listBackground === "rgb(23, 24, 22)"
      && darkChat.ownBackground === "rgb(36, 37, 32)"
      && darkChat.guestBackground === "rgba(0, 0, 0, 0)"
      && darkChat.guestBorderLeft === "rgb(201, 81, 0)"
      && darkChat.ownShadow === "none"
      && darkChat.guestShadow === "none",
    `The dark human Chat regained a muddy orange/brown slab or shadow: ${JSON.stringify(darkChat)}`
  );
  for (const [theme, result] of [["light", lightChat], ["dark", darkChat]]) {
    ensure(
      result.bodyFontSize === "14px"
        && result.bodyLineHeight === "20px"
        && result.metadataFontSize === "12px"
        && result.metadataLineHeight === "16px"
        && result.ownContrast >= 4.5
        && result.guestContrast >= 4.5
        && result.listOverflowY === "auto"
        && result.contained
        && !result.outerOverflowX
        && !result.outerOverflowY,
      `The ${theme} human Chat failed its type, contrast, or pane-containment contract: ${JSON.stringify(result)}`
    );
  }
  pass("human Chat uses flat, readable, pane-contained messages in both themes");

  async function captureAiChat(theme) {
    await rendererValue(`(() => { applyTheme(${JSON.stringify(theme)}); setRightRailTab("ai"); return true; })()`);
    await waitForRenderer(
      `document.documentElement.classList.contains("theme-${theme}") && document.querySelectorAll(".ai-chat-list .ai-message").length === 2`,
      `${theme} AI-chat presentation`
    );
    return rendererValue(`(() => {
      const colorParts = (value) => (String(value).match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (value) => {
        const channels = colorParts(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
      };
      const contrast = (foreground, background) => {
        const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const list = document.querySelector(".ai-chat-list");
      const panel = document.querySelector(".ai-helper-panel");
      const user = list?.querySelector(".ai-message-user");
      const assistant = list?.querySelector(".ai-message-assistant");
      const userBody = user?.querySelector(".ai-message-body");
      const assistantBody = assistant?.querySelector(".ai-message-body");
      const userRole = user?.querySelector(".ai-message-role");
      const userMarkdown = user?.querySelector(".ai-markdown");
      const role = assistant?.querySelector(".ai-message-role");
      const markdown = assistant?.querySelector(".ai-markdown");
      const code = markdown?.querySelector("code:not(pre code)");
      const pre = markdown?.querySelector("pre");
      const link = markdown?.querySelector("a");
      const fileChip = assistant?.querySelector(".ai-file-links button");
      const listStyle = list && getComputedStyle(list);
      const userRowStyle = user && getComputedStyle(user);
      const userStyle = userBody && getComputedStyle(userBody);
      const userRoleStyle = userRole && getComputedStyle(userRole);
      const userMarkdownStyle = userMarkdown && getComputedStyle(userMarkdown);
      const assistantStyle = assistantBody && getComputedStyle(assistantBody);
      const roleStyle = role && getComputedStyle(role);
      const markdownStyle = markdown && getComputedStyle(markdown);
      const codeStyle = code && getComputedStyle(code);
      const preStyle = pre && getComputedStyle(pre);
      const chipStyle = fileChip && getComputedStyle(fileChip);
      const listRect = list?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const userRect = user?.getBoundingClientRect();
      const userBodyRect = userBody?.getBoundingClientRect();
      const scrolling = document.scrollingElement;
      const isNeutral = (value) => {
        const channels = colorParts(value);
        return channels.length === 3 && Math.max(...channels) - Math.min(...channels) <= 6;
      };
      return {
        articles: Array.from(list?.querySelectorAll(".ai-message") || []).every((message) =>
          message.tagName === "ARTICLE" && / message$/.test(message.getAttribute("aria-label") || "")
        ),
        richTags: ["h2", "strong", "em", "ul li", "blockquote", "code", "pre code", "a"].every((selector) => Boolean(markdown?.querySelector(selector))),
        safeLink: link?.protocol === "https:" && link?.rel === "noopener noreferrer",
        listBackground: listStyle?.backgroundColor || "",
        listOverflowY: listStyle?.overflowY || "",
        userRowBackground: userRowStyle?.backgroundColor || "",
        userRowBorderWidth: userRowStyle?.borderTopWidth || "",
        userBackground: userStyle?.backgroundColor || "",
        userSurfaceNeutral: isNeutral(userStyle?.backgroundColor || ""),
        userShadow: userStyle?.boxShadow || "",
        userRadius: userStyle?.borderTopRightRadius || "",
        userRoleTransform: userRoleStyle?.textTransform || "",
        assistantBackground: assistantStyle?.backgroundColor || "",
        assistantBorderLeft: assistantStyle?.borderLeftColor || "",
        assistantShadow: assistantStyle?.boxShadow || "",
        roleColor: roleStyle?.color || "",
        roleFontSize: roleStyle?.fontSize || "",
        roleLineHeight: roleStyle?.lineHeight || "",
        bodyFontSize: markdownStyle?.fontSize || "",
        bodyLineHeight: markdownStyle?.lineHeight || "",
        codeFont: codeStyle?.fontFamily || "",
        codeBackground: codeStyle?.backgroundColor || "",
        preBackground: preStyle?.backgroundColor || "",
        chipText: fileChip?.textContent?.trim() || "",
        chipHeight: fileChip?.getBoundingClientRect().height || 0,
        chipFontSize: chipStyle?.fontSize || "",
        chipLineHeight: chipStyle?.lineHeight || "",
        bodyContrast: contrast(markdownStyle?.color || "rgb(0, 0, 0)", listStyle?.backgroundColor || "rgb(255, 255, 255)"),
        roleContrast: contrast(roleStyle?.color || "rgb(0, 0, 0)", listStyle?.backgroundColor || "rgb(255, 255, 255)"),
        userBodyContrast: contrast(userMarkdownStyle?.color || "rgb(0, 0, 0)", userStyle?.backgroundColor || "rgb(255, 255, 255)"),
        userRoleContrast: contrast(userRoleStyle?.color || "rgb(0, 0, 0)", userStyle?.backgroundColor || "rgb(255, 255, 255)"),
        userGeometry: Boolean(userRect && userBodyRect)
          && userBodyRect.width <= (userRect.width * 0.78) + 1
          && Math.abs(userRect.right - userBodyRect.right) <= 1
          && userBodyRect.left >= userRect.left - 1
          && userBodyRect.right <= userRect.right + 1,
        userContained: Boolean(userBody)
          && userBody.scrollWidth <= userBody.clientWidth + 1,
        contained: Boolean(listRect && panelRect)
          && listRect.left >= panelRect.left - 1
          && listRect.right <= panelRect.right + 1
          && listRect.top >= panelRect.top - 1
          && listRect.bottom <= panelRect.bottom + 1,
        outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
        outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
      };
    })()`);
  }

  const lightAi = await captureAiChat("light");
  const darkAi = await captureAiChat("dark");
  ensure(
    lightAi.articles
      && lightAi.richTags
      && lightAi.safeLink
      && lightAi.listBackground === "rgb(255, 255, 255)"
      && lightAi.userRowBackground === "rgba(0, 0, 0, 0)"
      && lightAi.userRowBorderWidth === "0px"
      && lightAi.userBackground === "rgb(251, 251, 250)"
      && lightAi.userSurfaceNeutral
      && lightAi.userRadius === "4px"
      && lightAi.userRoleTransform === "none"
      && lightAi.assistantBackground === "rgba(0, 0, 0, 0)"
      && lightAi.assistantBorderLeft === "rgb(201, 81, 0)"
      && lightAi.roleColor === "rgb(201, 81, 0)"
      && lightAi.preBackground === "rgb(247, 246, 243)"
      && lightAi.userShadow === "none"
      && lightAi.assistantShadow === "none",
    `The light AI transcript lost its neutral editorial surfaces or safe rich text: ${JSON.stringify(lightAi)}`
  );
  ensure(
    darkAi.articles
      && darkAi.richTags
      && darkAi.safeLink
      && darkAi.listBackground === "rgb(23, 24, 22)"
      && darkAi.userRowBackground === "rgba(0, 0, 0, 0)"
      && darkAi.userRowBorderWidth === "0px"
      && darkAi.userBackground === "rgb(28, 29, 26)"
      && darkAi.userSurfaceNeutral
      && darkAi.userRadius === "4px"
      && darkAi.userRoleTransform === "none"
      && darkAi.assistantBackground === "rgba(0, 0, 0, 0)"
      && darkAi.assistantBorderLeft === "rgb(201, 81, 0)"
      && darkAi.roleColor === "rgb(240, 161, 109)"
      && darkAi.preBackground === "rgb(17, 18, 16)"
      && darkAi.userShadow === "none"
      && darkAi.assistantShadow === "none",
    `The dark AI transcript regained a muddy orange/brown message slab: ${JSON.stringify(darkAi)}`
  );
  for (const [theme, result] of [["light", lightAi], ["dark", darkAi]]) {
    ensure(
      result.roleFontSize === "12px"
        && result.roleLineHeight === "16px"
        && result.bodyFontSize === "14px"
        && result.bodyLineHeight === "22px"
        && /Geist Mono/.test(result.codeFont)
        && result.chipText === "main.tex"
        && result.chipHeight === 24
        && result.chipFontSize === "11px"
        && result.chipLineHeight === "16px"
        && result.bodyContrast >= 4.5
        && result.userBodyContrast >= 4.5
        && result.userRoleContrast >= 4.5
        && result.userGeometry
        && result.userContained
        && result.roleContrast >= 4.5
        && result.listOverflowY === "auto"
        && result.contained
        && !result.outerOverflowX
        && !result.outerOverflowY,
      `The ${theme} AI transcript failed its rich-type, contrast, file-chip, or pane-containment contract: ${JSON.stringify(result)}`
    );
  }
  pass("AI Helper rich messages are flat, readable, and contained in both themes");

  await rendererValue(`(() => {
    const saved = window.__localLeafRenderedSmokeChatState;
    if (!saved) return false;
    local.appState.chat = saved.chat;
    local.aiMessages = saved.aiMessages;
    local.aiActivityMessage = saved.aiActivityMessage;
    applyTheme(saved.theme);
    setRightRailTab(saved.rightRailTab);
    delete window.__localLeafRenderedSmokeChatState;
    return true;
  })()`);
}

async function testEditorPdfFlow(baseUrl, fixture) {
  await smokeWindow.loadURL(`${baseUrl}/?view=editor&host=${encodeURIComponent(hostToken)}`);
  await installRendererErrorCapture();
  await waitForRenderer(
    `(() => Boolean(document.querySelector(".editor-shell") || document.querySelector(".app-error") || document.body.textContent.includes("LocalLeaf failed to start")))()`,
    "the editor shell"
  );
  const previewSetup = await rendererValue(`(() => ({
    hasEditor: Boolean(document.querySelector(".editor-shell")),
    hasMount: Boolean(document.querySelector(".pdf-preview-mount")),
    hasPreviewApi: typeof window.LocalLeafPdfPreview?.mount === "function",
    previewText: document.querySelector("#previewPane")?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 160) || "",
    appError: document.querySelector(".app-error")?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 160) || ""
  }))()`);
  ensure(previewSetup.hasEditor && previewSetup.hasPreviewApi && (previewSetup.hasMount || /Loading PDF preview/i.test(previewSetup.previewText)), `The editor did not mount the real PDF preview surface.${previewSetup.appError || previewSetup.previewText ? ` ${previewSetup.appError || previewSetup.previewText}` : ""}`);
  await waitForRenderer(
    `(() => {
      const tab = document.querySelector(".right-rail-tab.active");
      return Boolean(tab) && getComputedStyle(tab, "::after").opacity === "1";
    })()`,
    "the editor navigation underline"
  );
  const editorActionStyle = await rendererValue(`(() => {
    const action = document.querySelector("#compileButton");
    const tab = document.querySelector(".right-rail-tab.active");
    const actionStyle = getComputedStyle(action);
    const tabStyle = getComputedStyle(tab);
    const underline = getComputedStyle(tab, "::after");
    return {
      actionBackground: actionStyle.backgroundColor,
      actionColor: actionStyle.color,
      tabBackground: tabStyle.backgroundColor,
      tabBorder: tabStyle.borderTopColor,
      tabColor: tabStyle.color,
      underline: underline.backgroundColor,
      underlineOpacity: underline.opacity
    };
  })()`);
  ensure(
    editorActionStyle
      && editorActionStyle.actionBackground === "rgb(201, 81, 0)"
      && editorActionStyle.actionColor === "rgb(255, 255, 255)"
      && editorActionStyle.tabBackground === "rgba(0, 0, 0, 0)"
      && editorActionStyle.tabBorder === "rgba(0, 0, 0, 0)"
      && editorActionStyle.tabColor === "rgb(24, 24, 24)"
      && editorActionStyle.underline === "rgb(201, 81, 0)"
      && editorActionStyle.underlineOpacity === "1",
    "The editor action or selected rail tab drifted from the orange-button/underline-only contract."
  );
  pass("editor primary action and selected tab follow the orange/neutral contract");

  await testChatPresentation();

  await rendererValue(`(() => { document.querySelector("#editorMoreButton")?.click(); return true; })()`);
  await waitForRenderer(`Boolean(document.querySelector(".editor-more-menu"))`, "the editor workspace menu");

  await dispatchTrustedArrowKey("down");
  await dispatchTrustedArrowKey("up");
  await delay(220);
  const settingsFocusStyle = await rendererValue(`(() => {
    const settings = document.querySelector('[data-editor-more-action="settings"]');
    const style = settings && getComputedStyle(settings);
    const underline = settings && getComputedStyle(settings, "::after");
    return settings ? {
      focused: document.activeElement === settings,
      focusVisible: settings.matches(":focus-visible"),
      background: style.backgroundColor,
      border: style.borderTopColor,
      boxShadow: style.boxShadow,
      underline: underline.backgroundColor,
      underlineOpacity: underline.opacity,
      underlineTransform: underline.transform
    } : null;
  })()`);
  ensure(
    settingsFocusStyle
      && settingsFocusStyle.focused
      && settingsFocusStyle.focusVisible
      && settingsFocusStyle.background === "rgba(0, 0, 0, 0)"
      && settingsFocusStyle.border === "rgba(0, 0, 0, 0)"
      && settingsFocusStyle.boxShadow === "none"
      && settingsFocusStyle.underline === "rgb(201, 81, 0)"
      && settingsFocusStyle.underlineOpacity === "1"
      && settingsFocusStyle.underlineTransform !== "matrix(0, 0, 0, 1, 0, 0)",
    `The keyboard-focused Settings row regained a filled tile or lost its orange underline: ${JSON.stringify(settingsFocusStyle)}`
  );

  await moveTrustedPointerTo('[data-editor-more-action="settings"]');
  await delay(220);
  const settingsHoverStyle = await rendererValue(`(() => {
    const settings = document.querySelector('[data-editor-more-action="settings"]');
    const style = settings && getComputedStyle(settings);
    const underline = settings && getComputedStyle(settings, "::after");
    return settings ? {
      hovered: settings.matches(":hover"),
      background: style.backgroundColor,
      border: style.borderTopColor,
      boxShadow: style.boxShadow,
      underline: underline.backgroundColor,
      underlineOpacity: underline.opacity,
      underlineTransform: underline.transform
    } : null;
  })()`);
  ensure(
    settingsHoverStyle
      && settingsHoverStyle.hovered
      && settingsHoverStyle.background === "rgba(0, 0, 0, 0)"
      && settingsHoverStyle.border === "rgba(0, 0, 0, 0)"
      && settingsHoverStyle.boxShadow === "none"
      && settingsHoverStyle.underline === "rgb(201, 81, 0)"
      && settingsHoverStyle.underlineOpacity === "1"
      && settingsHoverStyle.underlineTransform !== "matrix(0, 0, 0, 1, 0, 0)",
    `The hovered Settings row regained a filled tile or lost its orange underline: ${JSON.stringify(settingsHoverStyle)}`
  );
  pass("workspace Settings row uses an underline-only hover and keyboard-focus state");

  const workspaceMenu = await rendererValue(`(() => {
    const menu = document.querySelector(".editor-more-menu");
    const update = menu?.querySelector("#editorCheckUpdates");
    const download = menu?.querySelector('a[download][href*="/api/export/zip"]');
    update?.focus();
    const originalTheme = typeof local === "object" ? local.theme : "light";
    const measure = (theme) => {
      applyTheme(theme);
      const rowRect = update.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const subtitleRect = update.querySelector("small").getBoundingClientRect();
      const copyRect = update.querySelector(".update-check-copy").getBoundingClientRect();
      const downloadCopyRect = download.querySelector(".editor-menu-copy").getBoundingClientRect();
      const style = getComputedStyle(update);
      const underline = getComputedStyle(update, "::after");
      const underlineHeight = Number.parseFloat(underline.height);
      const underlineBottom = Number.parseFloat(underline.bottom);
      const underlineTop = rowRect.bottom - underlineBottom - underlineHeight;
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        underline: underline.backgroundColor,
        underlineHeight,
        underlineBottom,
        subtitleClearance: underlineTop - subtitleRect.bottom,
        copyAlignmentDelta: Math.abs(copyRect.left - downloadCopyRect.left),
        rowInsideMenu: rowRect.top >= menuRect.top && rowRect.bottom <= menuRect.bottom
      };
    };
    const lightGeometry = measure("light");
    const darkGeometry = measure("dark");
    applyTheme(originalTheme);
    return {
      hasSetMainRow: Boolean(menu?.querySelector('[data-editor-more-action="set-main"]')),
      hasDownload: Boolean(download),
      updateRole: update?.getAttribute("role") || "",
      updateLabel: update?.getAttribute("aria-label") || "",
      updateHasTitle: update?.hasAttribute("title") || false,
      updateFocused: document.activeElement === update,
      lightGeometry,
      darkGeometry
    };
  })()`);
  const validUpdateGeometry = (geometry) => geometry
    && geometry.background === "rgba(0, 0, 0, 0)"
    && geometry.border === "rgba(0, 0, 0, 0)"
    && geometry.underline === "rgb(201, 81, 0)"
    && geometry.underlineHeight === 2
    && geometry.underlineBottom === 4
    && geometry.subtitleClearance >= 4
    && geometry.copyAlignmentDelta <= 0.5
    && geometry.rowInsideMenu;
  ensure(
    workspaceMenu
      && !workspaceMenu.hasSetMainRow
      && workspaceMenu.hasDownload
      && workspaceMenu.updateRole === "menuitem"
      && workspaceMenu.updateLabel === "Check for updates"
      && !workspaceMenu.updateHasTitle
      && workspaceMenu.updateFocused
      && validUpdateGeometry(workspaceMenu.lightGeometry)
      && validUpdateGeometry(workspaceMenu.darkGeometry),
    `The workspace update row lost its accessible label, gained a redundant title tooltip, or overlapped its underline: ${JSON.stringify(workspaceMenu)}`
  );
  await waitForRenderer(
    `(() => {
      const update = document.querySelector("#editorCheckUpdates");
      return Boolean(update)
        && getComputedStyle(update, "::after").backgroundColor === "rgb(201, 81, 0)"
        && getComputedStyle(update, "::after").opacity === "1";
    })()`,
    "the workspace update underline"
  );
  await rendererValue(`(() => { document.querySelector("#editorCheckUpdates")?.click(); return true; })()`);
  try {
    await waitForRenderer(
      `document.querySelector("#editorCheckUpdates [data-update-label]")?.textContent === "Up to date"`,
      "the workspace update result"
    );
  } catch (error) {
    const updateState = await rendererValue(`(() => ({
      label: document.querySelector("#editorCheckUpdates [data-update-label]")?.textContent || "missing",
      busy: document.querySelector("#editorCheckUpdates")?.getAttribute("aria-busy") || "missing",
      bound: document.querySelector("#editorCheckUpdates")?.dataset.updateCheckBound || "missing",
      checking: typeof local === "object" ? local.updateChecking : "unavailable",
      info: typeof local === "object" ? local.updateInfo : null
    }))()`);
    throw new Error(`${error.message} State: ${JSON.stringify(updateState)}`);
  }
  await rendererValue(`(() => { document.querySelector("#editorMoreButton")?.click(); return true; })()`);
  await waitForRenderer(`!document.querySelector(".editor-more-menu")`, "the workspace menu closing");
  pass("workspace menu omits the redundant main-file row and keeps update/ZIP actions accessible");

  await waitForRenderer(
    `(() => Boolean(
      document.querySelector(".pdf-page-canvas")
      || document.querySelector(".pdf-render-error")
      || document.querySelector(".app-error")
      || document.body.textContent.includes("LocalLeaf failed to start")
    ))()`,
    "the PDF preview outcome"
  );
  const previewOutcome = await rendererValue(`(() => ({
    hasCanvas: Boolean(document.querySelector(".pdf-page-canvas")),
    error: document.querySelector(".pdf-render-error")?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 240) || "",
    appError: document.querySelector(".app-error")?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 240) || "",
    failedToStart: document.body.textContent.includes("LocalLeaf failed to start")
  }))()`);
  ensure(previewOutcome.hasCanvas, `The PDF.js canvas did not render.${previewOutcome.error || previewOutcome.appError ? ` ${previewOutcome.error || previewOutcome.appError}` : previewOutcome.failedToStart ? " LocalLeaf failed to start." : ""}`);

  const renderState = await rendererValue(`(() => {
    const canvas = document.querySelector(".pdf-page-canvas");
    const scrolling = document.scrollingElement;
    const shell = document.querySelector(".editor-shell");
    const shellRect = shell?.getBoundingClientRect();
    return {
      canvasWidth: canvas?.width || 0,
      canvasHeight: canvas?.height || 0,
      width: innerWidth,
      height: innerHeight,
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1,
      shellInsideViewport: Boolean(shellRect) && shellRect.left >= -1 && shellRect.top >= -1 && shellRect.right <= innerWidth + 1 && shellRect.bottom <= innerHeight + 1,
      compileError: Boolean(document.querySelector(".pdf-render-error"))
    };
  })()`);
  ensure(renderState.width === 1024 && renderState.height === 640, "The smoke window did not expose the supported 1024x640 content viewport.");
  ensure(!renderState.outerOverflowX && !renderState.outerOverflowY && renderState.shellInsideViewport, "The editor escaped the supported 1024x640 viewport instead of using pane-local scrolling.");
  ensure(renderState.canvasWidth > 0 && renderState.canvasHeight > 0 && !renderState.compileError, "The compiled PDF did not reach a non-zero PDF.js canvas.");
  pass("PDF.js renders a canvas without compile/render error");
  pass("desktop editor is contained at 1024x640");

  const zoomBefore = await rendererValue(`document.querySelector(".pdf-page-canvas")?.getBoundingClientRect().width || 0`);
  await rendererValue(`(() => { document.querySelector("#pdfZoomIn")?.click(); return true; })()`);
  await waitForRenderer(
    `(() => {
      const width = document.querySelector(".pdf-page-canvas")?.getBoundingClientRect().width || 0;
      return document.querySelector("#pdfZoomValue")?.textContent === "110%" && width > ${zoomBefore + 1};
    })()`,
    "progressive PDF zoom geometry"
  );
  pass("progressive PDF zoom updates rendered geometry");

  const resizerPoint = await rendererValue(`(() => {
    const rect = document.querySelector("#sourcePreviewResizer")?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  ensure(resizerPoint, "The source/PDF resizer was not available for cancellation cleanup.");
  smokeWindow.webContents.sendInputEvent({ type: "mouseDown", x: resizerPoint.x, y: resizerPoint.y, button: "left", clickCount: 1 });
  await waitForRenderer(`document.body.classList.contains("is-resizing-split")`, "resizer pointer capture");
  await rendererValue(`(() => {
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    return true;
  })()`);
  smokeWindow.webContents.sendInputEvent({ type: "mouseUp", x: resizerPoint.x, y: resizerPoint.y, button: "left", clickCount: 1 });
  const resizeClean = await rendererValue(`(() => ({
    bodyClean: !Array.from(document.body.classList).some((name) => name.startsWith("is-resizing-")),
    stateClean: !local.resizingSidebar && !local.resizingSidebarSection && !local.resizingSplit && !local.resizingRightRail && !local.resizingLogs
  }))()`);
  ensure(resizeClean.bodyClean && resizeClean.stateClean, "Pointer cancellation left a resize mode or cursor class active.");
  pass("pointer cancellation clears resize state");

  await rendererValue(`(() => {
    window.__localLeafSmokeFetches = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = String(args[0]?.url || args[0] || "");
      const tracked = requestUrl.includes("/api/pdf/source-position") || requestUrl.includes("/api/file");
      const record = tracked ? { route: requestUrl.split("?")[0], state: "pending" } : null;
      if (record) window.__localLeafSmokeFetches.push(record);
      try {
        const response = await originalFetch(...args);
        if (record) Object.assign(record, { state: "complete", status: response.status });
        return response;
      } catch (error) {
        if (record) Object.assign(record, { state: "failed", error: String(error?.message || error) });
        throw error;
      }
    };
    const canvas = document.querySelector(".pdf-page-canvas");
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(80, rect.width / 3),
      clientY: rect.top + Math.min(100, rect.height / 3)
    }));
    return true;
  })()`);
  try {
    await waitForRenderer(
      `(() => {
        const status = document.querySelector("#pdfSourceStatus")?.textContent.trim() || "";
        return Boolean(status) && status !== "Finding source...";
      })()`,
      "PDF click-to-source status"
    );
  } catch (error) {
    const status = await rendererValue(`document.querySelector("#pdfSourceStatus")?.textContent.trim() || "empty"`);
    const fetches = await rendererValue(`window.__localLeafSmokeFetches || []`);
    const navigation = await rendererValue(`(() => ({
      selectedFile: typeof local === "object" ? local.selectedFile : "unavailable",
      saving: typeof local === "object" ? local.saving : null,
      pendingSave: typeof local === "object" ? local.pendingSave : null,
      hasSavePromise: typeof local === "object" ? Boolean(local.savePromise) : null,
      activeTag: document.activeElement?.tagName || ""
    }))()`);
    throw new Error(`${error.message} Renderer status: ${status}; host lookups: ${fixture.sourceLookups.length}; fetches: ${JSON.stringify(fetches)}; navigation: ${JSON.stringify(navigation)}.`);
  }
  const sourceStatus = await rendererValue(`document.querySelector("#pdfSourceStatus")?.textContent.trim() || ""`);
  ensure(sourceStatus.includes("mapped.tex") && sourceStatus.includes("line 2"), `The rendered PDF click did not report its mapped source line. Status: ${sourceStatus || "empty"}`);
  await waitForRenderer(`Boolean(document.activeElement?.closest?.(".cm-editor"))`, "mapped source editor focus");
  ensure(fixture.sourceLookups.length === 1, "The rendered PDF click did not make exactly one source-position lookup.");
  ensure(fixture.sourceLookups[0].page === 1 && fixture.sourceLookups[0].x > 0 && fixture.sourceLookups[0].y > 0, "The rendered PDF click did not send usable page coordinates.");
  pass("PDF click reveals and focuses its mapped source line");

  await rendererValue(`(() => {
    const tab = document.querySelector('[data-right-rail-tab="changes"]');
    tab?.click();
    return Boolean(tab);
  })()`);
  await waitForRenderer(
    `Boolean(document.querySelector('[data-review-ai-run="rendered-review-run"]'))`,
    "the rendered Changes Review action"
  );
  await rendererValue(`(() => {
    document.querySelector('[data-review-ai-run="rendered-review-run"]')?.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => {
      const marker = document.querySelector('.pdf-page[data-page-number="2"] .pdf-review-target');
      const status = document.querySelector('#changesReviewStatus')?.textContent || '';
      const markerRect = marker?.getBoundingClientRect();
      const previewRect = document.querySelector('#previewPane')?.getBoundingClientRect();
      const markerVisible = Boolean(markerRect && previewRect)
        && markerRect.bottom >= previewRect.top
        && markerRect.top <= previewRect.bottom;
      return Boolean(marker) && markerVisible && status.includes('Showing page 2');
    })()`,
    "Review locating the changed source on PDF page 2"
  );
  const reviewNavigation = await rendererValue(`(() => {
    const run = document.querySelector('[data-ai-run="rendered-review-run"]');
    const disclosure = run?.querySelector('.ai-run-actions [data-toggle-ai-run]');
    const marker = document.querySelector('.pdf-page[data-page-number="2"] .pdf-review-target');
    const page = marker?.closest('.pdf-page');
    const markerRect = marker?.getBoundingClientRect();
    const pageRect = page?.getBoundingClientRect();
    const previewRect = document.querySelector('#previewPane')?.getBoundingClientRect();
    const scrolling = document.scrollingElement;
    return {
      expanded: run?.classList.contains('expanded') || false,
      disclosureExpanded: disclosure?.getAttribute('aria-expanded') || '',
      disclosureControlsVisible: Boolean(disclosure?.getAttribute('aria-controls') && document.getElementById(disclosure.getAttribute('aria-controls'))),
      selectedFile: local.selectedFile,
      editorFocused: Boolean(document.activeElement?.closest?.('.cm-editor')),
      markerPage: marker?.dataset.pageNumber || '',
      markerLeft: markerRect && pageRect ? markerRect.left - pageRect.left : -1,
      markerTop: markerRect && pageRect ? markerRect.top - pageRect.top : -1,
      markerVisible: Boolean(markerRect && previewRect)
        && markerRect.bottom >= previewRect.top
        && markerRect.top <= previewRect.bottom,
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
    };
  })()`);
  ensure(fixture.forwardLookups.length === 1, "Review did not make exactly one source-to-PDF lookup.");
  ensure(
    fixture.forwardLookups[0].path === "mapped.tex"
      && fixture.forwardLookups[0].line === 2
      && fixture.forwardLookups[0].artifactId,
    `Review sent the wrong source or artifact identity: ${JSON.stringify(fixture.forwardLookups[0] || {})}`
  );
  ensure(
    reviewNavigation.expanded
      && reviewNavigation.disclosureExpanded === "true"
      && reviewNavigation.disclosureControlsVisible
      && reviewNavigation.selectedFile === "mapped.tex"
      && reviewNavigation.editorFocused
      && reviewNavigation.markerPage === "2"
      && Math.abs(reviewNavigation.markerLeft - 158.4) <= 3
      && Math.abs(reviewNavigation.markerTop - 264) <= 3
      && reviewNavigation.markerVisible
      && !reviewNavigation.outerOverflowX
      && !reviewNavigation.outerOverflowY,
    `Review did not reveal a contained, accessible PDF location: ${JSON.stringify(reviewNavigation)}`
  );
  pass("Changes Review opens the source and reveals its mapped PDF location");

  fs.writeFileSync(fixture.currentPdfPath, Buffer.from("%PDF-1.7\ninvalid rendered smoke body\n%%EOF\n", "ascii"));
  await rendererValue(`(() => {
    window.LocalLeafPdfPreview.remount(document.querySelector("#previewPane"), { scale: 1 });
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector(".pdf-render-error [data-pdf-retry]"))`, "the visible PDF retry state");
  fs.writeFileSync(fixture.currentPdfPath, fixture.validPdfBytes);
  await rendererValue(`(() => { document.querySelector("[data-pdf-retry]").click(); return true; })()`);
  await waitForRenderer(
    `(() => {
      const canvas = document.querySelector(".pdf-page-canvas");
      return canvas && canvas.width > 0 && canvas.height > 0 && !document.querySelector(".pdf-render-error");
    })()`,
    "PDF retry recovery"
  );
  pass("visible PDF retry recovers after a render failure");

  fixture.failNextCompile = true;
  const failedCompile = await hostRequest(baseUrl, "/api/compile", { method: "POST", body: {} });
  ensure(failedCompile.status === "failed" && failedCompile.pdfAvailable && failedCompile.isStale, "A failed compile did not preserve the last good PDF state.");
  await waitForRenderer(
    `(() => {
      const note = document.querySelector(".compile-stale-note");
      const canvas = document.querySelector(".pdf-page-canvas");
      return note?.textContent.includes("Last good PDF") && canvas && canvas.width > 0 && canvas.height > 0;
    })()`,
    "the rendered last-good PDF state"
  );
  pass("failed recompile keeps the last-good rendered PDF");

  const pageErrors = await rendererValue(`window.__localLeafRenderedSmokeErrors || []`);
  ensure(Array.isArray(pageErrors) && pageErrors.length === 0, `The renderer reported an uncaught error: ${pageErrors?.[0] || "unknown"}`);
}

async function run() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-rendered-smoke-"));
  app.setPath("userData", path.join(tempRoot, "electron-user-data"));
  const projectRoot = path.join(tempRoot, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "LocalLeaf rendered smoke.",
      "Mapped source line.",
      "\\end{document}"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(projectRoot, "mapped.tex"),
    ["Mapped file heading.", "Mapped source line."].join("\n"),
    "utf8"
  );
  fs.mkdirSync(path.join(projectRoot, "chapters"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "chapters", "introduction.tex"),
    ["\\section{Introduction}", "Nested smoke fixture."].join("\n"),
    "utf8"
  );

  const fixture = {
    currentPdfPath: "",
    failNextCompile: false,
    forwardLookups: [],
    sourceLookups: [],
    validPdfBytes: Buffer.from(createDeterministicPdf({ pageCount: 2 }))
  };

  const modelRoot = path.join(tempRoot, "models");
  installReadyProviderFixture(modelRoot);

  hostServer = createLocalLeafServer({
    port: 0,
    projectRoot,
    autoStartTunnel: false,
    modelRoot,
    aiSessionRoot: path.join(tempRoot, "ai-sessions"),
    aiChangeRoot: path.join(tempRoot, "ai-changes"),
    fetchLatestRelease: async () => ({
      currentVersion: "0.1.22",
      latestVersion: "0.1.22",
      updateAvailable: false,
      downloads: {}
    }),
    compileProject: async (_sourceRoot, _mainFile, onLog, context = {}) => {
      onLog?.("[LocalLeaf rendered smoke] deterministic compile");
      if (fixture.failNextCompile) {
        fixture.failNextCompile = false;
        return {
          ok: false,
          engine: "rendered-smoke",
          mode: "html",
          logs: ["[LocalLeaf rendered smoke] intentional compile failure"],
          previewHtml: "",
          pdfPath: null,
          synctexPath: null,
          artifactRoot: context.compileSnapshot?.artifactRoot || null,
          sourceSnapshotRoot: context.compileSnapshot?.sourceSnapshotRoot || null,
          stale: false
        };
      }
      const artifactRoot = context.compileSnapshot?.artifactRoot;
      ensure(artifactRoot, "The compile smoke fixture did not receive an artifact directory.");
      const pdfPath = path.join(artifactRoot, "main.pdf");
      const synctexPath = path.join(artifactRoot, "main.synctex.gz");
      fs.writeFileSync(pdfPath, fixture.validPdfBytes);
      fs.writeFileSync(synctexPath, "rendered smoke SyncTeX fixture", "utf8");
      fixture.currentPdfPath = pdfPath;
      return {
        ok: true,
        engine: "rendered-smoke",
        mode: "pdf",
        logs: ["[LocalLeaf rendered smoke] compile complete"],
        previewHtml: "",
        pdfPath,
        synctexPath,
        artifactRoot,
        sourceSnapshotRoot: context.compileSnapshot?.sourceSnapshotRoot || null,
        stale: false
      };
    },
    synctexResolver: ({ page, x, y }) => {
      fixture.sourceLookups.push({ page, x, y });
      return { ok: true, path: "mapped.tex", line: 2, column: 0 };
    },
    synctexForwardResolver: ({ relativePath, line, column, artifactId, version }) => {
      fixture.forwardLookups.push({ path: relativePath, line, column, artifactId, version });
      return { ok: true, page: 2, x: 144, y: 240, width: 120, height: 24 };
    }
  });
  await hostServer.start(0);
  hostToken = hostServer.state.hostToken;
  const baseUrl = `http://127.0.0.1:${hostServer.state.port}`;
  const compiled = await hostRequest(baseUrl, "/api/compile", { method: "POST", body: {} });
  ensure(compiled.status === "success" && compiled.pdfAvailable && compiled.sourceMapAvailable, "The deterministic compile fixture did not publish a mapped PDF.");
  const mappedText = fs.readFileSync(path.join(projectRoot, "mapped.tex"), "utf8");
  hostServer.state.ai.changes.upsert(hostServer.state.project, {
    id: "rendered-review-change",
    runId: "rendered-review-run",
    path: "mapped.tex",
    baseHash: crypto.createHash("sha256").update("Mapped file heading.\nBefore the AI change.", "utf8").digest("hex"),
    newHash: crypto.createHash("sha256").update(mappedText, "utf8").digest("hex"),
    status: "applied",
    summary: "Updated the mapped source line",
    userRequest: "Tighten the mapped sentence.",
    provider: { id: "opencode-go", name: "OpenCode Go" },
    modelId: "kimi-k2.5",
    focus: { start: mappedText.indexOf("Mapped source line."), end: mappedText.length, line: 2, column: 0 },
    diffHunks: [{
      oldStart: 2,
      newStart: 2,
      lines: [
        { type: "removed", text: "Before the AI change." },
        { type: "added", text: "Mapped source line." }
      ]
    }],
    createdAt: Date.now() - 2_000,
    appliedAt: Date.now() - 1_000
  });

  const rendererConsoleErrors = [];
  smokeWindow = new BrowserWindow({
    width: 1024,
    height: 640,
    useContentSize: true,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  smokeWindow.setContentSize(1024, 640);
  smokeWindow.webContents.on("console-message", (event) => {
    const level = event?.level;
    const message = event?.message;
    if (level === "error" || level === 3) rendererConsoleErrors.push(String(message || "renderer console error"));
  });
  smokeWindow.webContents.on("render-process-gone", (_event, details) => {
    rendererConsoleErrors.push(`renderer process exited: ${details?.reason || "unknown"}`);
  });
  smokeWindow.webContents.on("did-fail-load", (_event, code, description) => {
    if (code !== -3) rendererConsoleErrors.push(`document load failed: ${description || code}`);
  });

  await testHostStartupAndHelp(baseUrl);
  await testDesktopThemeParity(baseUrl);
  await testEditorPdfFlow(baseUrl, fixture);
  ensure(rendererConsoleErrors.length === 0, `The renderer console reported an error: ${rendererConsoleErrors[0] || "unknown"}`);
  pass("renderer console and process stayed healthy");
  process.stdout.write("[rendered-smoke] COMPLETE\n");
}

async function finish(code, error = null) {
  if (finishing) return;
  finishing = true;
  clearTimeout(hardTimeout);
  if (error) process.stderr.write(`[rendered-smoke] FAIL ${redact(error)}\n`);
  try {
    if (smokeWindow && !smokeWindow.isDestroyed()) smokeWindow.destroy();
  } catch {
    // Continue fixture cleanup even when Chromium has already exited.
  }
  try {
    if (hostServer) await hostServer.stop();
  } catch (stopError) {
    if (!error) process.stderr.write(`[rendered-smoke] FAIL ${redact(stopError)}\n`);
    code = 1;
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exitCode = code;
  process.exit(code);
}

hardTimeout = setTimeout(() => {
  finish(1, new Error(`Rendered smoke exceeded its ${SMOKE_TIMEOUT_MS}ms process deadline.`));
}, SMOKE_TIMEOUT_MS);

process.on("uncaughtException", (error) => finish(1, error));
process.on("unhandledRejection", (error) => finish(1, error));

app.whenReady()
  .then(run)
  .then(() => finish(0))
  .catch((error) => finish(1, error));
