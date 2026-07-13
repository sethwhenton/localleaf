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

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await waitForRenderer(
    `!matchMedia("(prefers-reduced-motion: reduce)").matches`,
    "the normal-motion navigation baseline"
  );
  await rendererValue(`(() => {
    if (local.hostRailCollapsed) {
      local.hostRailCollapsed = false;
      localStorage.setItem("localleaf.hostRailCollapsed", "0");
      render();
    }
    return true;
  })()`);
  await waitForRenderer(`!document.querySelector(".host-nav-rail")?.classList.contains("host-nav-rail-collapsed")`, "the expanded navigation baseline");
  await rendererValue(`document.querySelector("#railCollapse")?.click()`);
  await waitForRenderer(
    `document.querySelector("#app")?.classList.contains("app-shell-rail-collapsing") && document.querySelector(".host-nav-rail")?.classList.contains("host-nav-rail-collapsed")`,
    "the left navigation collapse motion"
  );
  const railCollapseMotion = await rendererValue(`(() => ({
    rail: getComputedStyle(document.querySelector(".host-nav-rail")).animationName,
    content: getComputedStyle(document.querySelector(".window-content")).animationName,
    collapsed: document.querySelector(".host-nav-rail")?.classList.contains("host-nav-rail-collapsed") || false,
    labelHidden: getComputedStyle(document.querySelector("#railHome .host-rail-label")).display === "none"
  }))()`);
  ensure(
    railCollapseMotion.collapsed
      && railCollapseMotion.labelHidden
      && railCollapseMotion.rail.includes("localleaf-rail-collapse-in")
      && railCollapseMotion.content.includes("localleaf-content-shift-left"),
    `The left navigation did not collapse with compositor motion: ${JSON.stringify(railCollapseMotion)}`
  );
  await rendererValue(`document.querySelector("#railCollapse")?.click()`);
  await waitForRenderer(
    `document.querySelector("#app")?.classList.contains("app-shell-rail-expanding") && !document.querySelector(".host-nav-rail")?.classList.contains("host-nav-rail-collapsed")`,
    "the left navigation expand motion"
  );
  const railExpandMotion = await rendererValue(`(() => ({
    rail: getComputedStyle(document.querySelector(".host-nav-rail")).animationName,
    content: getComputedStyle(document.querySelector(".window-content")).animationName,
    label: getComputedStyle(document.querySelector("#railHome .host-rail-label")).animationName,
    expandedLabel: document.querySelector("#railCollapse .host-rail-label")?.textContent?.trim() || ""
  }))()`);
  ensure(
    railExpandMotion.rail.includes("localleaf-rail-expand-in")
      && railExpandMotion.content.includes("localleaf-content-shift-right")
      && railExpandMotion.label.includes("localleaf-rail-label-in")
      && railExpandMotion.expandedLabel === "Collapse",
    `The left navigation did not open smoothly: ${JSON.stringify(railExpandMotion)}`
  );
  await delay(360);
  ensure(
    await rendererValue(`!document.querySelector("#app")?.classList.contains("app-shell-rail-expanding")`),
    "The left navigation entrance class did not clean itself up."
  );
  await setEmulatedMediaFeatures([]);
  pass("left navigation opens and collapses with restrained compositor motion");

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
  await delay(220);
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
      && Math.abs(providerStatusStyle.height - 20) <= 0.5
      && providerStatusStyle.metadataFontSize === "11px"
      && providerStatusStyle.metadataLineHeight === "16px"
      && Math.abs(providerStatusStyle.metadataHeight - 20) <= 0.5,
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
    document.querySelector('#settingsTab-models')?.click();
    const disclosure = document.querySelector('#settingsPanel-models:not([hidden]) [data-toggle-provider-model-group]');
    if (disclosure?.getAttribute('aria-expanded') === 'false') disclosure.click();
    return true;
  })()`);
  await waitForRenderer(
    `(() => {
      const disclosure = document.querySelector('#settingsPanel-models:not([hidden]) [data-toggle-provider-model-group]');
      const panel = disclosure?.getAttribute('aria-controls')
        ? document.getElementById(disclosure.getAttribute('aria-controls'))
        : null;
      return Boolean(disclosure && panel && !panel.hidden && disclosure.getAttribute('aria-expanded') === 'true');
    })()`,
    "the expanded provider model group"
  );
  const modelGroupCollapseStart = await rendererValue(`(() => {
    const modal = document.querySelector('.settings-preferences-modal');
    const options = modal?.querySelector('.settings-options');
    const disclosure = modal?.querySelector('#settingsPanel-models:not([hidden]) [data-toggle-provider-model-group]');
    const panel = disclosure?.getAttribute('aria-controls')
      ? document.getElementById(disclosure.getAttribute('aria-controls'))
      : null;
    if (!modal || !options || !disclosure || !panel) return null;
    const maxScrollTop = Math.max(0, options.scrollHeight - options.clientHeight);
    options.scrollTop = Math.min(24, maxScrollTop);
    window.__localLeafSettingsModalIdentity = modal;
    window.__localLeafModelDisclosureIdentity = disclosure;
    window.__localLeafModelGroupScrollTop = options.scrollTop;
    disclosure.focus({ preventScroll: true });
    disclosure.click();
    return {
      modalSame: document.querySelector('.settings-preferences-modal') === modal,
      disclosureSame: document.querySelector('[data-toggle-provider-model-group]') === disclosure,
      focused: document.activeElement === disclosure,
      expanded: disclosure.getAttribute('aria-expanded'),
      hiding: panel.classList.contains('is-hiding'),
      transitionProperty: getComputedStyle(panel).transitionProperty,
      startHeight: panel.getBoundingClientRect().height,
      panelHidden: panel.hidden
    };
  })()`);
  ensure(
    modelGroupCollapseStart
      && modelGroupCollapseStart.modalSame
      && modelGroupCollapseStart.disclosureSame
      && modelGroupCollapseStart.focused
      && modelGroupCollapseStart.expanded === "false"
      && modelGroupCollapseStart.hiding
      && modelGroupCollapseStart.transitionProperty.includes("max-height")
      && modelGroupCollapseStart.startHeight > 0
      && !modelGroupCollapseStart.panelHidden,
    `The provider model group did not begin its in-place collapse cleanly: ${JSON.stringify(modelGroupCollapseStart)}`
  );
  await waitForRenderer(
    `(() => {
      const disclosure = window.__localLeafModelDisclosureIdentity;
      const panel = disclosure?.getAttribute('aria-controls')
        ? document.getElementById(disclosure.getAttribute('aria-controls'))
        : null;
      return Boolean(panel?.hidden);
    })()`,
    "the provider model group collapse"
  );
  const modelGroupCollapsed = await rendererValue(`(() => {
    const modal = document.querySelector('.settings-preferences-modal');
    const options = modal?.querySelector('.settings-options');
    const disclosure = window.__localLeafModelDisclosureIdentity;
    const providerId = disclosure?.dataset.toggleProviderModelGroup || '';
    const panel = disclosure?.getAttribute('aria-controls')
      ? document.getElementById(disclosure.getAttribute('aria-controls'))
      : null;
    const stored = JSON.parse(localStorage.getItem('localleaf.aiModelGroups.v1') || '{}');
    const expectedScrollTop = Math.min(
      window.__localLeafModelGroupScrollTop || 0,
      Math.max(0, (options?.scrollHeight || 0) - (options?.clientHeight || 0))
    );
    return {
      modalSame: modal === window.__localLeafSettingsModalIdentity,
      disclosureSame: document.querySelector('[data-toggle-provider-model-group]') === disclosure,
      focused: document.activeElement === disclosure,
      expanded: disclosure?.getAttribute('aria-expanded') || '',
      hidden: Boolean(panel?.hidden),
      inert: panel?.hasAttribute('inert') || false,
      scrollDelta: Math.abs((options?.scrollTop || 0) - expectedScrollTop),
      stored: stored[providerId],
      hasChevron: Boolean(disclosure?.querySelector('.tool-icon-chevronDown'))
    };
  })()`);
  ensure(
    modelGroupCollapsed
      && modelGroupCollapsed.modalSame
      && modelGroupCollapsed.disclosureSame
      && modelGroupCollapsed.focused
      && modelGroupCollapsed.expanded === "false"
      && modelGroupCollapsed.hidden
      && modelGroupCollapsed.inert
      && modelGroupCollapsed.scrollDelta <= 1
      && modelGroupCollapsed.stored === false
      && modelGroupCollapsed.hasChevron,
    `The collapsed provider model group lost identity, focus, scroll, persistence, or disclosure semantics: ${JSON.stringify(modelGroupCollapsed)}`
  );

  const modelGroupExpandStart = await rendererValue(`(() => {
    const disclosure = window.__localLeafModelDisclosureIdentity;
    const panel = disclosure?.getAttribute('aria-controls')
      ? document.getElementById(disclosure.getAttribute('aria-controls'))
      : null;
    disclosure?.click();
    return {
      expanded: disclosure?.getAttribute('aria-expanded') || '',
      hidden: Boolean(panel?.hidden),
      revealing: panel?.classList.contains('is-revealing') || false,
      transitionProperty: panel ? getComputedStyle(panel).transitionProperty : '',
      maxHeight: panel ? getComputedStyle(panel).maxHeight : '',
      focused: document.activeElement === disclosure,
      modalSame: document.querySelector('.settings-preferences-modal') === window.__localLeafSettingsModalIdentity
    };
  })()`);
  ensure(
    modelGroupExpandStart
      && modelGroupExpandStart.expanded === "true"
      && !modelGroupExpandStart.hidden
      && modelGroupExpandStart.revealing
      && modelGroupExpandStart.transitionProperty.includes("max-height")
      && modelGroupExpandStart.maxHeight !== "none"
      && modelGroupExpandStart.focused
      && modelGroupExpandStart.modalSame,
    `The provider model group did not begin its in-place reveal cleanly: ${JSON.stringify(modelGroupExpandStart)}`
  );
  await waitForRenderer(
    `(() => {
      const disclosure = window.__localLeafModelDisclosureIdentity;
      const panel = disclosure?.getAttribute('aria-controls')
        ? document.getElementById(disclosure.getAttribute('aria-controls'))
        : null;
      const providerId = disclosure?.dataset.toggleProviderModelGroup || '';
      const stored = JSON.parse(localStorage.getItem('localleaf.aiModelGroups.v1') || '{}');
      return Boolean(
        panel
        && !panel.hidden
        && !panel.classList.contains('is-revealing')
        && disclosure?.getAttribute('aria-expanded') === 'true'
        && stored[providerId] === true
      );
    })()`,
    "the provider model group reveal"
  );

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const modelGroupReducedMotion = await rendererValue(`(() => {
    const disclosure = window.__localLeafModelDisclosureIdentity;
    const panel = disclosure?.getAttribute('aria-controls')
      ? document.getElementById(disclosure.getAttribute('aria-controls'))
      : null;
    disclosure?.click();
    const collapsed = {
      hidden: Boolean(panel?.hidden),
      hiding: panel?.classList.contains('is-hiding') || false,
      focused: document.activeElement === disclosure
    };
    disclosure?.click();
    return {
      ...collapsed,
      reopened: Boolean(panel && !panel.hidden && disclosure?.getAttribute('aria-expanded') === 'true'),
      revealing: panel?.classList.contains('is-revealing') || false
    };
  })()`);
  await setEmulatedMediaFeatures([]);
  ensure(
    modelGroupReducedMotion
      && modelGroupReducedMotion.hidden
      && !modelGroupReducedMotion.hiding
      && modelGroupReducedMotion.focused
      && modelGroupReducedMotion.reopened
      && !modelGroupReducedMotion.revealing,
    `The provider model disclosure did not become immediate under reduced motion: ${JSON.stringify(modelGroupReducedMotion)}`
  );
  pass("Settings model groups expand in place with preserved focus, scroll, persistence, and reduced-motion behavior");

  await rendererValue(`(() => {
    const button = document.querySelector("#configureCustomModel");
    button?.focus();
    button?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector(".provider-modal"))`, "the custom provider dialog");
  await delay(220);
  const providerDialog = await rendererValue(`(() => {
    const dialog = document.querySelector(".provider-modal");
    const body = dialog?.querySelector(".provider-form-body");
    const save = dialog?.querySelector('.provider-form-actions button[type="submit"]');
    const test = dialog?.querySelector("#testProviderForm");
    const remove = dialog?.querySelector("[data-remove-provider-row]");
    const close = dialog?.querySelector("[data-close-provider]");
    const modelRow = dialog?.querySelector('[data-provider-row="model"]');
    const scrolling = document.scrollingElement;
    const rect = dialog?.getBoundingClientRect();
    return {
      role: dialog?.getAttribute("role") || "",
      modal: dialog?.getAttribute("aria-modal") || "",
      labelledBy: dialog?.getAttribute("aria-labelledby") || "",
      describedBy: dialog?.getAttribute("aria-describedby") || "",
      focusedName: document.activeElement?.getAttribute("name") || "",
      advancedCopy: dialog?.querySelector(".provider-form-advanced p")?.textContent || "",
      visibleContextInputs: dialog?.querySelectorAll('input[type="number"], input[name="model-context-window"]')?.length || 0,
      modelTextInputs: modelRow?.querySelectorAll('input:not([type="hidden"])')?.length || 0,
      removeIcon: Boolean(remove?.querySelector(".tool-icon-delete")),
      removeLabel: remove?.getAttribute("aria-label") || "",
      removeSize: remove ? Number.parseFloat(getComputedStyle(remove).height) : 0,
      closeIcon: Boolean(close?.querySelector(".tool-icon-close")),
      closeLabel: close?.getAttribute("aria-label") || "",
      saveText: save?.textContent?.trim() || "",
      saveBackground: save ? getComputedStyle(save).backgroundColor : "",
      saveColor: save ? getComputedStyle(save).color : "",
      testBackground: test ? getComputedStyle(test).backgroundColor : "",
      bodyOverflow: body ? getComputedStyle(body).overflowY : "",
      modelColumns: modelRow ? getComputedStyle(modelRow).gridTemplateColumns.split(" ").length : 0,
      contained: Boolean(rect) && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
      outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
    };
  })()`);
  ensure(
    providerDialog.role === "dialog"
      && providerDialog.modal === "true"
      && providerDialog.labelledBy === "providerDialogTitle"
      && providerDialog.describedBy === "providerDialogDescription"
      && providerDialog.focusedName === "displayName"
      && providerDialog.advancedCopy.includes("Context window is managed by the provider")
      && providerDialog.visibleContextInputs === 0
      && providerDialog.modelTextInputs === 2
      && providerDialog.modelColumns === 3
      && providerDialog.removeIcon
      && providerDialog.removeLabel.startsWith("Remove model")
      && providerDialog.removeSize >= 40
      && providerDialog.closeIcon
      && providerDialog.closeLabel === "Close provider dialog",
    `The custom provider dialog lost its compact fields or accessible controls: ${JSON.stringify(providerDialog)}`
  );
  ensure(
    providerDialog.saveText === "Save provider"
      && providerDialog.saveBackground === "rgb(201, 81, 0)"
      && providerDialog.saveColor === "rgb(255, 255, 255)"
      && providerDialog.testBackground !== providerDialog.saveBackground
      && ["auto", "scroll"].includes(providerDialog.bodyOverflow)
      && providerDialog.contained
      && !providerDialog.outerOverflowX
      && !providerDialog.outerOverflowY,
    `The custom provider dialog drifted from its action or viewport contract: ${JSON.stringify(providerDialog)}`
  );
  const providerAdvancedClosed = await rendererValue(`(() => {
    const details = document.querySelector(".provider-form-advanced");
    const body = details?.querySelector(".provider-form-advanced-body");
    const chevron = details?.querySelector(".provider-advanced-chevron .tool-icon");
    const bodyStyle = body && getComputedStyle(body);
    const chevronStyle = chevron && getComputedStyle(chevron);
    return {
      nativeDetails: details?.tagName === "DETAILS",
      open: Boolean(details?.open),
      maxHeight: bodyStyle?.maxHeight || "",
      opacity: bodyStyle?.opacity || "",
      visibility: bodyStyle?.visibility || "",
      bodyDuration: bodyStyle?.transitionDuration || "",
      chevronWidth: chevronStyle?.width || "",
      chevronDuration: chevronStyle?.transitionDuration || ""
    };
  })()`);
  ensure(
    providerAdvancedClosed?.nativeDetails
      && !providerAdvancedClosed.open
      && providerAdvancedClosed.maxHeight === "0px"
      && providerAdvancedClosed.opacity === "0"
      && providerAdvancedClosed.visibility === "hidden"
      && providerAdvancedClosed.bodyDuration.includes("0.45s")
      && providerAdvancedClosed.chevronWidth === "18px"
      && providerAdvancedClosed.chevronDuration.includes("0.35s"),
    `The Advanced context disclosure lost its native, compact motion contract: ${JSON.stringify(providerAdvancedClosed)}`
  );
  await rendererValue(`document.querySelector(".provider-form-advanced summary")?.click()`);
  await waitForRenderer(
    `(() => {
      const details = document.querySelector(".provider-form-advanced");
      const body = details?.querySelector(".provider-form-advanced-body");
      return Boolean(details?.open && body && Number.parseFloat(getComputedStyle(body).opacity) >= 0.99);
    })()`,
    "the Advanced context disclosure reveal"
  );
  const providerAdvancedOpen = await rendererValue(`(() => {
    const details = document.querySelector(".provider-form-advanced");
    const body = details?.querySelector(".provider-form-advanced-body");
    const chevron = details?.querySelector(".provider-advanced-chevron .tool-icon");
    return {
      maxHeight: body ? getComputedStyle(body).maxHeight : "",
      visibility: body ? getComputedStyle(body).visibility : "",
      chevronTransform: chevron ? getComputedStyle(chevron).transform : ""
    };
  })()`);
  ensure(
    providerAdvancedOpen?.maxHeight !== "0px"
      && providerAdvancedOpen.visibility === "visible"
      && providerAdvancedOpen.chevronTransform !== "none",
    `The Advanced context disclosure did not reveal cleanly: ${JSON.stringify(providerAdvancedOpen)}`
  );
  await rendererValue(`document.querySelector(".provider-form-advanced summary")?.click()`);
  await waitForRenderer(
    `getComputedStyle(document.querySelector(".provider-form-advanced-body")).visibility === "hidden"`,
    "the Advanced context disclosure close"
  );
  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await rendererValue(`document.querySelector(".provider-form-advanced summary")?.click()`);
  const providerAdvancedReduced = await rendererValue(`(() => ({
    open: document.querySelector(".provider-form-advanced")?.open || false,
    bodyDuration: getComputedStyle(document.querySelector(".provider-form-advanced-body")).transitionDuration,
    chevronDuration: getComputedStyle(document.querySelector(".provider-advanced-chevron .tool-icon")).transitionDuration
  }))()`);
  ensure(
    providerAdvancedReduced.open
      && Number.parseFloat(providerAdvancedReduced.bodyDuration) <= 0.00002
      && Number.parseFloat(providerAdvancedReduced.chevronDuration) <= 0.00002,
    `Reduced motion did not make the Advanced context disclosure immediate: ${JSON.stringify(providerAdvancedReduced)}`
  );
  await setEmulatedMediaFeatures([]);
  pass("Advanced context handling uses a native, reversible, reduced-motion-safe disclosure");
  const providerLegacyModelCompatibility = await rendererValue(`(() => {
    const rows = document.querySelector('[data-provider-rows="models"]');
    if (!rows) return null;
    rows.innerHTML = providerFormRows(
      [{ id: "legacy-model", name: "Legacy label", contextWindowTokens: 16384 }],
      "model",
      "model",
      "alias"
    );
    const payload = formProviderPayload();
    return {
      id: payload.models[0]?.id || "",
      name: payload.models[0]?.name || "",
      contextWindowTokens: payload.models[0]?.contextWindowTokens || 0,
      visibleContextInputs: rows.querySelectorAll('input[type="number"], input[name="model-context-window"]').length
    };
  })()`);
  ensure(
    providerLegacyModelCompatibility?.id === "legacy-model"
      && providerLegacyModelCompatibility?.name === "Legacy label"
      && providerLegacyModelCompatibility?.contextWindowTokens === 16384
      && providerLegacyModelCompatibility?.visibleContextInputs === 0,
    `The provider dialog did not retain existing model compatibility metadata invisibly: ${JSON.stringify(providerLegacyModelCompatibility)}`
  );
  await verifyCurrentThemePair(
    "Custom provider dialog",
    [".provider-modal", ".provider-modal-head", ".provider-form-section", ".provider-form-advanced", ".provider-form-actions"],
    [".provider-modal-head p", ".provider-section-heading > div > span", ".provider-form-body label", ".provider-form-advanced summary"]
  );
  await rendererValue(`(() => {
    applyTheme("light");
    document.querySelector(".provider-modal-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  await waitForRenderer(`!document.querySelector(".provider-modal")`, "custom provider dialog closing");
  await delay(40);
  const providerDialogFocusRestored = await rendererValue(`document.activeElement?.id || document.activeElement?.tagName || ""`);
  ensure(
    providerDialogFocusRestored === "configureCustomModel",
    `The custom provider dialog did not restore focus to its opener: ${providerDialogFocusRestored}`
  );
  pass("custom provider dialog is compact, provider-managed, accessible, and theme-safe");

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
      if (document.querySelectorAll(".help-qa-list details").length === 9) return true;
      document.querySelector("#railHelp")?.click();
      return false;
    })()`,
    "the Help disclosures"
  );

  const helpGuideResult = await rendererValue(`(() => {
    const modal = document.querySelector(".info-modal-help");
    const body = modal?.querySelector(".help-qa-list");
    const details = Array.from(body?.querySelectorAll("details") || []);
    const modalRect = modal?.getBoundingClientRect();
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      topics: details.map((item) => item.querySelector(".help-topic")?.textContent?.trim() || ""),
      questions: details.map((item) => item.querySelector("summary strong")?.textContent?.trim() || ""),
      answers: details.map((item) => item.querySelector(".help-answer p")?.textContent?.trim() || ""),
      nativeSummaries: details.every((item) => item.querySelector("summary")?.tabIndex === 0),
      openItems: details.filter((item) => item.open).length,
      labelled: modal?.getAttribute("aria-labelledby") === "infoModalTitle"
        && modal?.getAttribute("aria-describedby") === "infoModalSubtitle",
      modalContained: Boolean(modalRect)
        && modalRect.left >= 0
        && modalRect.top >= 0
        && modalRect.right <= innerWidth
        && modalRect.bottom <= innerHeight,
      bodyOverflowY: bodyStyle?.overflowY || "",
      bodyOwnsScroll: Boolean(body) && body.scrollHeight > body.clientHeight,
      outerOverflow: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
    };
  })()`);
  ensure(
    helpGuideResult.topics.join("|") === "Projects|Hosting|Access|Collaboration|Compilation|AI and privacy|AI changes|Invite links|Backups"
      && helpGuideResult.questions.includes("Can two people edit the same file at once?")
      && helpGuideResult.questions.includes("Does AI send my project away from this computer?")
      && helpGuideResult.answers.join(" ").includes("last arrival wins")
      && helpGuideResult.answers.join(" ").includes("last good copy")
      && helpGuideResult.answers.join(" ").includes("Provider keys")
      && helpGuideResult.answers.join(" ").includes("previous link")
      && helpGuideResult.answers.join(" ").includes("Existing approvals remain"),
    `The Help guide is missing practical project, session, compilation, or AI guidance: ${JSON.stringify(helpGuideResult)}`
  );
  ensure(
    helpGuideResult.nativeSummaries
      && helpGuideResult.openItems === 1
      && helpGuideResult.labelled
      && helpGuideResult.modalContained
      && helpGuideResult.bodyOverflowY === "auto"
      && helpGuideResult.bodyOwnsScroll
      && !helpGuideResult.outerOverflow,
    `The Help guide lost native disclosure semantics or viewport-owned scrolling: ${JSON.stringify(helpGuideResult)}`
  );

  const mouseResult = await rendererValue(`(() => {
    const details = document.querySelectorAll(".help-qa-list details")[1];
    const summary = details?.querySelector("summary");
    const answer = details?.querySelector(".help-answer");
    const icon = details?.querySelector(".help-disclosure-icon");
    if (!summary) return null;
    const before = details.open;
    const answerStyle = getComputedStyle(answer);
    const iconStyle = getComputedStyle(icon);
    const closed = {
      maxHeight: answerStyle.maxHeight,
      opacity: answerStyle.opacity,
      visibility: answerStyle.visibility,
      duration: answerStyle.transitionDuration,
      iconWidth: iconStyle.width,
      iconDuration: iconStyle.transitionDuration
    };
    summary.click();
    return {
      before,
      after: details.open,
      closed,
      expandedLabel: getComputedStyle(details.querySelector(".help-disclosure-label-expanded")).display !== "none"
    };
  })()`);
  ensure(
    mouseResult
      && !mouseResult.before
      && mouseResult.after
      && mouseResult.expandedLabel
      && mouseResult.closed.maxHeight === "0px"
      && mouseResult.closed.opacity === "0"
      && mouseResult.closed.visibility === "hidden"
      && mouseResult.closed.duration.includes("0.45s")
      && mouseResult.closed.iconWidth === "18px"
      && mouseResult.closed.iconDuration.includes("0.35s"),
    `A Help disclosure lost its compact closed or activation state: ${JSON.stringify(mouseResult)}`
  );
  await waitForRenderer(
    `(() => Number.parseFloat(getComputedStyle(document.querySelectorAll(".help-answer")[1]).opacity) >= 0.99)()`,
    "the Help answer reveal"
  );
  const helpOpenMotion = await rendererValue(`(() => ({
    maxHeight: getComputedStyle(document.querySelectorAll(".help-answer")[1]).maxHeight,
    visibility: getComputedStyle(document.querySelectorAll(".help-answer")[1]).visibility,
    chevronTransform: getComputedStyle(document.querySelectorAll(".help-disclosure-icon")[1]).transform
  }))()`);
  ensure(
    helpOpenMotion.maxHeight !== "0px"
      && helpOpenMotion.visibility === "visible"
      && helpOpenMotion.chevronTransform !== "none",
    `The Help answer did not reveal with its chevron state: ${JSON.stringify(helpOpenMotion)}`
  );
  await rendererValue(`document.querySelectorAll(".help-qa-list details")[1]?.querySelector("summary")?.click()`);
  await waitForRenderer(
    `document.querySelectorAll(".help-qa-list details")[1]?.open === false`,
    "the Help answer closing"
  );
  await waitForRenderer(
    `(() => {
      const answer = document.querySelectorAll(".help-answer")[1];
      const icon = document.querySelectorAll(".help-disclosure-icon")[1];
      return Number.parseFloat(getComputedStyle(answer).opacity) <= 0.01
        && getComputedStyle(answer).visibility === "hidden"
        && getComputedStyle(icon).transform === "none";
    })()`,
    "the Help answer closed motion settling"
  );
  const helpClosedMotion = await rendererValue(`(() => ({
    opacity: getComputedStyle(document.querySelectorAll(".help-answer")[1]).opacity,
    visibility: getComputedStyle(document.querySelectorAll(".help-answer")[1]).visibility,
    chevronTransform: getComputedStyle(document.querySelectorAll(".help-disclosure-icon")[1]).transform
  }))()`);
  ensure(
    helpClosedMotion.opacity === "0"
      && helpClosedMotion.visibility === "hidden"
      && helpClosedMotion.chevronTransform === "none",
    `The Help answer did not reverse to its closed state: ${JSON.stringify(helpClosedMotion)}`
  );

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
  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const helpReducedMotion = await rendererValue(`(() => ({
    answer: getComputedStyle(document.querySelectorAll(".help-answer")[2]).transitionDuration,
    icon: getComputedStyle(document.querySelectorAll(".help-disclosure-icon")[2]).transitionDuration
  }))()`);
  ensure(
    Number.parseFloat(helpReducedMotion.answer) <= 0.00002
      && Number.parseFloat(helpReducedMotion.icon) <= 0.00002,
    `Reduced motion did not make Help disclosures immediate: ${JSON.stringify(helpReducedMotion)}`
  );
  await setEmulatedMediaFeatures([]);

  smokeWindow.setContentSize(900, 640);
  await waitForRenderer(`innerWidth === 900 && innerHeight === 640`, "the 900x640 Help viewport");
  const compactHelp = await rendererValue(`(() => {
    const modal = document.querySelector(".info-modal-help");
    const body = modal?.querySelector(".help-qa-list");
    const rect = modal?.getBoundingClientRect();
    return {
      contained: Boolean(rect) && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      bodyOwnsScroll: Boolean(body) && body.scrollHeight > body.clientHeight,
      outerOverflow: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
    };
  })()`);
  ensure(
    compactHelp.contained && compactHelp.bodyOwnsScroll && !compactHelp.outerOverflow,
    `Help lost pane-owned containment at 900x640: ${JSON.stringify(compactHelp)}`
  );
  smokeWindow.setContentSize(1024, 640);
  await waitForRenderer(`innerWidth === 1024 && innerHeight === 640`, "the restored Help viewport");
  pass("Help disclosures respond to mouse and keyboard with reversible, reduced-motion-safe reveals");

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
    const modal = document.querySelector(".info-modal-about");
    const website = body?.querySelector(".about-website-link");
    const modalRect = modal?.getBoundingClientRect();
    return {
      product: body?.querySelector(".about-product-name")?.textContent?.trim() || "",
      principles: Array.from(body?.querySelectorAll(".about-values span") || []).map((item) => item.textContent.trim()),
      details: Array.from(body?.querySelectorAll(".about-detail dt") || []).map((item) => item.textContent.trim()),
      workingModel: body?.querySelector(".about-working-model p")?.textContent?.trim() || "",
      boundaryTitle: body?.querySelector(".about-boundaries h3")?.textContent?.trim() || "",
      boundaries: body?.querySelector(".about-boundaries p")?.textContent?.trim() || "",
      audience: body?.querySelector(".about-footer-row > span")?.textContent?.trim() || "",
      decorativeIcons: body?.querySelectorAll("svg, .ui-glyph, .brand-symbol").length || 0,
      websiteLabel: website?.textContent?.trim() || "",
      websiteUrl: website?.href || "",
      websiteBackground: website ? getComputedStyle(website).backgroundColor : "",
      websiteColor: website ? getComputedStyle(website).color : "",
      closeLabel: document.querySelector(".info-modal-about [data-close-info]")?.getAttribute("aria-label") || "",
      labelled: modal?.getAttribute("aria-labelledby") === "infoModalTitle"
        && modal?.getAttribute("aria-describedby") === "infoModalSubtitle",
      modalContained: Boolean(modalRect)
        && modalRect.left >= 0
        && modalRect.top >= 0
        && modalRect.right <= innerWidth
        && modalRect.bottom <= innerHeight,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : "",
      bodyOwnsScroll: Boolean(body) && body.scrollHeight > body.clientHeight,
      outerOverflow: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
    };
  })()`);
  ensure(
    aboutResult.product === "LocalLeaf"
      && aboutResult.principles.join("|") === "Private by design|Host powered"
      && aboutResult.details.join("|") === "Local files|Approved guests|Clear roles|Host compile|Optional AI|Project chat"
      && aboutResult.workingModel.includes("normal project folder")
      && aboutResult.boundaryTitle === "Current boundaries"
      && aboutResult.boundaries.includes("host must stay online")
      && aboutResult.boundaries.includes("last-arrival-wins")
      && aboutResult.audience.includes("research groups"),
    "The About view is missing its product principles or core collaboration details."
  );
  ensure(aboutResult.decorativeIcons === 0, "The About content reintroduced decorative icons.");
  ensure(aboutResult.websiteLabel === "Visit website" && /^https:\/\//.test(aboutResult.websiteUrl), "The About website action is missing or unsafe.");
  ensure(
    aboutResult.websiteBackground === "rgb(201, 81, 0)" && aboutResult.websiteColor === "rgb(255, 255, 255)",
    "The About website action drifted from the accessible orange-and-white primary action contract."
  );
  ensure(aboutResult.closeLabel === "Close", "The About dialog close action lost its accessible name.");
  ensure(
    aboutResult.labelled
      && aboutResult.modalContained
      && aboutResult.bodyOverflowY === "auto"
      && aboutResult.bodyOwnsScroll
      && !aboutResult.outerOverflow,
    `The About view lost its accessible dialog relationship or pane-owned scrolling: ${JSON.stringify(aboutResult)}`
  );

  smokeWindow.setContentSize(900, 640);
  await waitForRenderer(`innerWidth === 900 && innerHeight === 640`, "the 900x640 About viewport");
  const compactAbout = await rendererValue(`(() => {
    const modal = document.querySelector(".info-modal-about");
    const body = modal?.querySelector(".about-editorial");
    const rect = modal?.getBoundingClientRect();
    return {
      contained: Boolean(rect) && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      bodyOwnsScroll: Boolean(body) && body.scrollHeight > body.clientHeight,
      outerOverflow: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
    };
  })()`);
  ensure(
    compactAbout.contained && compactAbout.bodyOwnsScroll && !compactAbout.outerOverflow,
    `About lost pane-owned containment at 900x640: ${JSON.stringify(compactAbout)}`
  );
  smokeWindow.setContentSize(1024, 640);
  await waitForRenderer(`innerWidth === 1024 && innerHeight === 640`, "the restored About viewport");
  pass("About view is detailed, icon-free, accessible, and contained");

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
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
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
    (() => {
      const properties = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
      const compositorOnly = (value) => properties(value).every((property) => ["transform", "opacity"].includes(property));
      const thumbProperties = properties(initialThemeSwitch.thumbTransition);
      const reducedMotionSafe = initialThemeSwitch.reducedMotion
        && thumbProperties.length === 1
        && thumbProperties[0] === "none"
        && initialThemeSwitch.iconTransitions.every((value) => {
          const iconProperties = properties(value);
          return iconProperties.length === 1 && iconProperties[0] === "none";
        });
      if (reducedMotionSafe) return true;
      return thumbProperties.includes("transform")
        && compositorOnly(initialThemeSwitch.thumbTransition)
        && initialThemeSwitch.iconTransitions.every((value) => {
          const iconProperties = properties(value);
          return iconProperties.includes("transform")
            && iconProperties.includes("opacity")
            && compositorOnly(value);
        });
    })(),
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
  await rendererValue(`(() => {
    const root = document.documentElement;
    root.style.setProperty("--motion-fast", "0ms");
    applyTheme(${JSON.stringify(theme)});
    void root.offsetWidth;
    root.style.removeProperty("--motion-fast");
    return true;
  })()`);
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
    const settingsMotion = await rendererValue(`(() => ({
      backdrop: getComputedStyle(document.querySelector(".settings-modal-backdrop")).animationName,
      dialog: getComputedStyle(document.querySelector(".settings-preferences-modal")).animationName
    }))()`);
    ensure(
      settingsMotion.backdrop.includes("localleaf-backdrop-in")
        && settingsMotion.dialog.includes("localleaf-dialog-in"),
      `Settings did not use the restrained dialog entrance at ${width}x${height}: ${JSON.stringify(settingsMotion)}`
    );
    for (const tab of ["general", "providers", "models", "permissions"]) {
      await rendererValue(`document.querySelector(${JSON.stringify(`#settingsTab-${tab}`)})?.click()`);
      await waitForRenderer(`Boolean(document.querySelector(${JSON.stringify(`#settingsPanel-${tab}:not([hidden])`)}))`, `${tab} Settings parity panel`);
      await verifyCurrentThemePair(`Settings ${tab}`, [".settings-preferences-modal", ".settings-modal-head", ".settings-options", `#settingsPanel-${tab}:not([hidden]) .settings-list-card, #settingsPanel-${tab}:not([hidden]) .settings-section-intro, #settingsPanel-${tab}:not([hidden]) .settings-general-hero`], [".settings-modal-head p", `#settingsPanel-${tab}:not([hidden]) .settings-list-main span`, `#settingsPanel-${tab}:not([hidden]) .settings-model-heading`]);
    }
    await rendererValue(`document.querySelector("[data-close-settings]")?.click()`);
    await waitForRenderer(`!document.querySelector(".settings-preferences-modal")`, "Settings parity dialog closing");
    await rendererValue(`document.querySelector("#railHelp")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".help-qa-list"))`, "Help parity dialog");
    await verifyCurrentThemePair("Help", [".info-modal", ".info-modal .settings-modal-head", ".help-qa-list", ".help-qa-list details:first-child"], [".settings-modal-head p", ".help-qa-list summary .help-step", ".help-question-copy .help-topic", ".help-qa-list summary strong", ".help-qa-list details[open] .help-answer p"]);
    await rendererValue(`document.querySelector("[data-close-info]")?.click()`);
    await waitForRenderer(`!document.querySelector(".info-modal")`, "Help parity dialog closing");
    await rendererValue(`document.querySelector("#railAbout")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".about-editorial"))`, "About parity dialog");
    await verifyCurrentThemePair("About", [".info-modal", ".info-modal .settings-modal-head", ".about-editorial", ".about-working-model", ".about-detail-list", ".about-boundaries"], [".settings-modal-head p", ".about-summary", ".about-working-model h3", ".about-working-model p", ".about-detail dt", ".about-detail dd", ".about-boundaries h3", ".about-boundaries p", ".about-footer-row > span"]);

    await loadHostView(baseUrl, "project", ".project-app-page");
    if (width === 1024) {
      await rendererValue(`setView("home")`);
      await waitForRenderer(`Boolean(document.querySelector(".home-app-page"))`, "Home route before motion check");
      await rendererValue(`setView("project")`);
      await waitForRenderer(`document.querySelector("#app")?.classList.contains("app-shell-view-enter")`, "Project route entrance motion");
      const routeMotion = await rendererValue(`getComputedStyle(document.querySelector(".project-app-grid")).animationName`);
      ensure(routeMotion.includes("localleaf-view-rise-in"), `Project route did not use the one-shot entrance motion: ${routeMotion}`);
      await delay(420);
      const routeMotionSettled = await rendererValue(`!document.querySelector("#app")?.classList.contains("app-shell-view-enter")`);
      ensure(routeMotionSettled, "Project route entrance class did not clean itself up.");
    }
    await verifyCurrentThemePair("Project", [".titlebar", ".host-nav-rail", ".window-content", ".project-primary-panel", ".project-details-panel", ".status-list"], [".project-app-head p", ".section-title", ".status-warn", ".project-detail-list span"]);
    const projectPlacement = await rendererValue(`(() => {
      const content = document.querySelector(".window-content")?.getBoundingClientRect();
      const page = document.querySelector(".project-app-page")?.getBoundingClientRect();
      const contentStyle = document.querySelector(".window-content")
        ? getComputedStyle(document.querySelector(".window-content"))
        : null;
      const scrolling = document.scrollingElement;
      return content && page ? {
        horizontalOffset: Math.abs((page.left + (page.width / 2)) - (content.left + (content.width / 2))),
        topInset: page.top - content.top,
        contentPaddingTop: Number.parseFloat(contentStyle?.paddingTop || "0"),
        pageInsideContent: page.top >= content.top - 1 && page.bottom <= content.bottom + 1,
        outerOverflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
        outerOverflowY: scrolling.scrollHeight > scrolling.clientHeight + 1
      } : null;
    })()`);
    ensure(
      projectPlacement
        && projectPlacement.horizontalOffset <= 1
        && Math.abs(projectPlacement.topInset - projectPlacement.contentPaddingTop) <= 1
        && projectPlacement.pageInsideContent
        && !projectPlacement.outerOverflowX
        && !projectPlacement.outerOverflowY,
      `Project Overview is not top-aligned and contained at ${width}x${height}: ${JSON.stringify(projectPlacement)}`
    );

    await loadHostView(baseUrl, "session", ".session-share-page");
    await verifyCurrentThemePair("Session", [".titlebar", ".host-nav-rail", ".window-content", ".session-invite-panel", ".session-side-card", ".session-empty-panel"], [".session-panel-title", ".session-empty-panel span", ".session-provider-hint", ".session-state-pill"]);
    const sessionSignal = await rendererValue(`(() => {
      const bars = [...document.querySelectorAll(".session-state-pill .session-signal-bars > span")];
      return {
        count: bars.length,
        phase: document.querySelector(".session-state-pill")?.className || "",
        animation: bars[0] ? getComputedStyle(bars[0]).animationName : ""
      };
    })()`);
    ensure(
      sessionSignal.count === 4 && sessionSignal.phase.includes("phase-idle") && sessionSignal.animation === "none",
      `Inactive hosted-session signal was not truthful and static at ${width}x${height}: ${JSON.stringify(sessionSignal)}`
    );
    const providerPicker = await rendererValue(`(() => {
      const trigger = document.querySelector("#sessionTunnelProvider");
      const menu = document.querySelector("#sessionTunnelProviderMenu");
      if (!trigger || !menu || trigger.disabled) return null;
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      const active = document.activeElement;
      const style = getComputedStyle(trigger);
      const menuStyle = getComputedStyle(menu);
      return {
        nativeSelectPresent: Boolean(document.querySelector(".session-provider-control select")),
        expanded: trigger.getAttribute("aria-expanded"),
        menuHidden: menu.getAttribute("aria-hidden"),
        activeRole: active?.getAttribute("role") || "",
        optionCount: menu.querySelectorAll('[role="option"]').length,
        triggerHeight: trigger.getBoundingClientRect().height,
        triggerRadius: style.borderRadius,
        menuRadius: menuStyle.borderRadius,
        menuTransition: menuStyle.transitionProperty
      };
    })()`);
    ensure(
      providerPicker
        && !providerPicker.nativeSelectPresent
        && providerPicker.expanded === "true"
        && providerPicker.menuHidden === "false"
        && providerPicker.activeRole === "option"
        && providerPicker.optionCount >= 2
        && providerPicker.triggerHeight >= 40
        && providerPicker.triggerRadius === "8px"
        && providerPicker.menuRadius === "12px"
        && providerPicker.menuTransition.includes("transform")
        && providerPicker.menuTransition.includes("opacity"),
      `Session provider picker lost its compact accessible menu treatment at ${width}x${height}: ${JSON.stringify(providerPicker)}`
    );
    await verifyCurrentThemePair("Session provider menu", [".session-provider-trigger", ".session-provider-menu", ".session-provider-option"], [".session-provider-trigger-copy strong", ".session-provider-option-copy strong"]);
    const providerPickerClosed = await rendererValue(`(() => {
      const option = document.activeElement;
      option?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const trigger = document.querySelector("#sessionTunnelProvider");
      return trigger?.getAttribute("aria-expanded") === "false" && document.activeElement === trigger;
    })()`);
    ensure(providerPickerClosed, "Session provider menu did not return focus to its trigger on Escape.");
    const providerPickerSelection = await rendererValue(`(() => {
      const page = document.querySelector(".session-share-page");
      const trigger = document.querySelector("#sessionTunnelProvider");
      const menu = document.querySelector("#sessionTunnelProviderMenu");
      const option = [...(menu?.querySelectorAll('[role="option"]') || [])]
        .find((item) => item.getAttribute("aria-selected") !== "true");
      if (!page || !trigger || !menu || !option) return null;
      const expectedValue = option.querySelector("strong")?.textContent?.trim() || "";
      trigger.click();
      option.focus();
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return {
        pageSame: document.querySelector(".session-share-page") === page,
        triggerSame: document.querySelector("#sessionTunnelProvider") === trigger,
        expanded: trigger.getAttribute("aria-expanded"),
        menuHidden: menu.getAttribute("aria-hidden"),
        focused: document.activeElement === trigger,
        selected: option.getAttribute("aria-selected"),
        expectedValue,
        triggerValue: document.querySelector("#sessionTunnelProviderValue")?.textContent?.trim() || ""
      };
    })()`);
    ensure(
      providerPickerSelection
        && providerPickerSelection.pageSame
        && providerPickerSelection.triggerSame
        && providerPickerSelection.expanded === "false"
        && providerPickerSelection.menuHidden === "true"
        && providerPickerSelection.focused
        && providerPickerSelection.selected === "true"
        && providerPickerSelection.expectedValue === providerPickerSelection.triggerValue,
      `Selecting a Session provider rebuilt the page or lost picker state at ${width}x${height}: ${JSON.stringify(providerPickerSelection)}`
    );

    await loadHostView(baseUrl, "editor", ".editor-shell");
    await verifyCurrentThemePair("Editor", [".editor-shell", ".editor-topbar", ".editor-format-row", ".sidebar", ".code-panel", ".preview-panel", ".right-rail", ".log-dock"], [".editor-help", ".folder-count", ".user-row .avatar", ".chat-empty"]);
    await verifyCurrentThemePair("Editor navigation and logs", [".file-list", ".sidebar-images-panel", ".outline", ".log-tabs", ".log-output"], [".folder-count", ".outline-title", ".log-chip.info"]);
    const editorNavigationAndLogs = await rendererValue(`(() => {
      const firstFile = document.querySelector(".file-button");
      const imageToggle = document.querySelector(".image-section-toggle");
      const outlineRow = document.querySelector(".outline-row");
      const logs = document.querySelector(".logs");
      const logLine = document.querySelector(".log-line");
      const logSummary = document.querySelector(".log-summary");
      return {
        fileIcon: Boolean(firstFile?.querySelector(".tool-icon")),
        imageChevron: Boolean(imageToggle?.querySelector(".tool-icon-chevronRight")),
        outlineIcon: outlineRow ? Boolean(outlineRow.querySelector(".tool-icon")) : true,
        fileHeight: firstFile?.getBoundingClientRect().height || 0,
        outlineHeight: outlineRow?.getBoundingClientRect().height || 32,
        summaryDisplay: logSummary ? getComputedStyle(logSummary).display : "",
        logOverflow: logs ? getComputedStyle(logs).overflowY : "",
        logRadius: logLine ? getComputedStyle(logLine).borderRadius : "0px",
        logBackgroundImage: getComputedStyle(document.querySelector(".log-output")).backgroundImage
      };
    })()`);
    ensure(
      editorNavigationAndLogs.fileIcon
        && editorNavigationAndLogs.imageChevron
        && editorNavigationAndLogs.outlineIcon
        && editorNavigationAndLogs.fileHeight >= 32
        && editorNavigationAndLogs.outlineHeight >= 32
        && editorNavigationAndLogs.summaryDisplay === "flex"
        && ["auto", "scroll"].includes(editorNavigationAndLogs.logOverflow)
        && editorNavigationAndLogs.logRadius === "0px"
        && editorNavigationAndLogs.logBackgroundImage === "none",
      `Editor navigation or diagnostics lost the minimalist treatment at ${width}x${height}: ${JSON.stringify(editorNavigationAndLogs)}`
    );
    const quickSearchCollapsed = await rendererValue(`(() => {
      const launcher = document.querySelector("#editorSearchLauncher");
      const surface = launcher?.querySelector(".editor-search-launcher-surface");
      const toggle = document.querySelector("#editorSearchToggle");
      const spacer = document.querySelector(".editor-search-reserved-space");
      const launcherRect = launcher?.getBoundingClientRect();
      const surfaceRect = surface?.getBoundingClientRect();
      const toggleRect = toggle?.getBoundingClientRect();
      const spacerRect = spacer?.getBoundingClientRect();
      return {
        launcherWidth: launcherRect?.width || 0,
        surfaceWidth: surfaceRect?.width || 0,
        toggleWidth: toggleRect?.width || 0,
        toggleHeight: toggleRect?.height || 0,
        spacerWidth: spacerRect?.width || 0,
        expanded: toggle?.getAttribute("aria-expanded"),
        transitionProperties: surface ? getComputedStyle(surface, "::before").transitionProperty : "",
        outerOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1
      };
    })()`);
    ensure(
      quickSearchCollapsed.launcherWidth >= 55
        && quickSearchCollapsed.launcherWidth <= 57
        && quickSearchCollapsed.surfaceWidth >= 229
        && quickSearchCollapsed.surfaceWidth <= 231
        && quickSearchCollapsed.toggleWidth >= 55
        && quickSearchCollapsed.toggleHeight >= 40
        && quickSearchCollapsed.spacerWidth >= 173
        && quickSearchCollapsed.expanded === "false"
        && quickSearchCollapsed.transitionProperties.includes("transform")
        && !quickSearchCollapsed.outerOverflowX,
      `The compact editor search launcher lost its reserved, non-reflowing geometry at ${width}x${height}: ${JSON.stringify(quickSearchCollapsed)}`
    );
    await rendererValue(`document.querySelector(".editor-search-launcher-surface")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await delay(430);
    const quickSearchExpanded = await rendererValue(`(() => {
      const launcher = document.querySelector("#editorSearchLauncher");
      const surface = launcher?.querySelector(".editor-search-launcher-surface");
      const input = document.querySelector("#editorQuickSearchInput");
      const spacer = document.querySelector(".editor-search-reserved-space");
      const previous = spacer?.previousElementSibling;
      const surfaceRect = surface?.getBoundingClientRect();
      const spacerRect = spacer?.getBoundingClientRect();
      const previousRect = previous?.getBoundingClientRect();
      const transform = surface ? getComputedStyle(surface, "::before").transform : "";
      const transformValues = transform.match(/matrix\\(([^)]+)\\)/)?.[1]?.split(",").map(Number) || [];
      return {
        focused: document.activeElement === input,
        inputOpacity: input ? getComputedStyle(input).opacity : "",
        scaleX: transform === "none" ? 1 : transformValues[0],
        staysInsideReservedLane: Boolean(surfaceRect && spacerRect && previousRect)
          && surfaceRect.left >= spacerRect.left - 1
          && surfaceRect.left >= previousRect.right - 1,
        outerOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1
      };
    })()`);
    ensure(
      quickSearchExpanded.focused
        && Number(quickSearchExpanded.inputOpacity) >= 0.99
        && Number(quickSearchExpanded.scaleX) >= 0.99
        && quickSearchExpanded.staysInsideReservedLane
        && !quickSearchExpanded.outerOverflowX,
      `The editor search launcher did not expand smoothly inside its reserved lane at ${width}x${height}: ${JSON.stringify(quickSearchExpanded)}`
    );
    const quickSearchEscape = await rendererValue(`(() => {
      const input = document.querySelector("#editorQuickSearchInput");
      input.value = "main";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return {
        blurred: document.activeElement !== input,
        panelClosed: !document.querySelector(".editor-search-popover"),
        expanded: document.querySelector("#editorSearchToggle")?.getAttribute("aria-expanded")
      };
    })()`);
    ensure(
      quickSearchEscape.blurred && quickSearchEscape.panelClosed && quickSearchEscape.expanded === "false",
      `Escape did not collapse the editor search launcher at ${width}x${height}: ${JSON.stringify(quickSearchEscape)}`
    );
    await rendererValue(`(() => {
      const input = document.querySelector("#editorQuickSearchInput");
      input?.focus();
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    await waitForRenderer(
      `Boolean(document.querySelector(".editor-search-popover")) && document.activeElement?.id === "editorSearchInput"`,
      "Enter opening the editor search and replace surface"
    );
    const quickSearchEnter = await rendererValue(`(() => ({
      expanded: document.querySelector("#editorSearchToggle")?.getAttribute("aria-expanded"),
      quickQuery: document.querySelector("#editorQuickSearchInput")?.value || "",
      panelQuery: document.querySelector("#editorSearchInput")?.value || ""
    }))()`);
    ensure(
      quickSearchEnter.expanded === "true"
        && quickSearchEnter.quickQuery === "main"
        && quickSearchEnter.panelQuery === "main",
      `Enter did not open search with the synchronized quick query at ${width}x${height}: ${JSON.stringify(quickSearchEnter)}`
    );
    const searchUiDark = await rendererValue(`(() => {
      const popover = document.querySelector(".editor-search-popover");
      const scope = document.querySelector(".editor-search-scope");
      const activeScope = scope?.querySelector("button.active");
      const rect = popover?.getBoundingClientRect();
      return {
        areas: popover ? getComputedStyle(popover).gridTemplateAreas : "",
        background: popover ? getComputedStyle(popover).backgroundColor : "",
        scopeBackground: scope ? getComputedStyle(scope).backgroundColor : "",
        activeUnderline: activeScope ? getComputedStyle(activeScope, "::after").opacity : "",
        actionBackground: getComputedStyle(document.querySelector("#replaceAll")).backgroundColor,
        actionColor: getComputedStyle(document.querySelector("#replaceAll")).color,
        quickQuerySynced: document.querySelector("#editorSearchInput")?.value === "main",
        hasNavigationIcons: Boolean(document.querySelector("#searchPrevious .tool-icon-arrowUp") && document.querySelector("#searchNext .tool-icon-arrowDown") && document.querySelector("#closeSearchPanel .tool-icon-close")),
        contained: Boolean(rect) && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
        outerOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1,
        outerOverflowY: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1
      };
    })()`);
    ensure(
      searchUiDark.areas.includes("scope")
        && searchUiDark.background !== "rgb(255, 255, 255)"
        && searchUiDark.scopeBackground === "rgba(0, 0, 0, 0)"
        && searchUiDark.activeUnderline === "1"
        && searchUiDark.actionBackground === "rgb(201, 81, 0)"
        && searchUiDark.actionColor === "rgb(255, 255, 255)"
        && searchUiDark.quickQuerySynced
        && searchUiDark.hasNavigationIcons
        && searchUiDark.contained
        && !searchUiDark.outerOverflowX
        && !searchUiDark.outerOverflowY,
      `The editor search surface drifted from its minimal dark-theme contract at ${width}x${height}: ${JSON.stringify(searchUiDark)}`
    );
    await rendererValue(`(() => {
      const root = document.documentElement;
      root.style.setProperty("--motion-fast", "0ms");
      applyTheme("light");
      void root.offsetWidth;
      root.style.removeProperty("--motion-fast");
      return true;
    })()`);
    const searchUiLight = await rendererValue(`(() => ({
      background: getComputedStyle(document.querySelector(".editor-search-popover")).backgroundColor,
      actionBackground: getComputedStyle(document.querySelector("#replaceAll")).backgroundColor,
      actionColor: getComputedStyle(document.querySelector("#replaceAll")).color
    }))()`);
    ensure(
      searchUiLight.background === "rgb(255, 255, 255)"
        && searchUiLight.actionBackground === "rgb(201, 81, 0)"
        && searchUiLight.actionColor === "rgb(255, 255, 255)",
      `The editor search surface drifted from its light-theme action contract at ${width}x${height}: ${JSON.stringify(searchUiLight)}`
    );
    await rendererValue(`document.querySelector("#closeSearchPanel")?.click()`);
    await waitForRenderer(`!document.querySelector(".editor-search-popover")`, "the editor search surface closing");
    const sidebarMotion = await rendererValue(`(() => {
      setSidebarVisible(false);
      setSidebarVisible(true);
      const shell = document.querySelector(".editor-shell");
      const sidebar = document.querySelector(".sidebar");
      return {
        opening: shell?.classList.contains("sidebar-opening"),
        visible: sidebar ? getComputedStyle(sidebar).display !== "none" : false,
        animation: sidebar ? getComputedStyle(sidebar).animationName : ""
      };
    })()`);
    ensure(
      sidebarMotion.opening && sidebarMotion.visible && sidebarMotion.animation.includes("localleaf-pane-left-in"),
      `Editor sidebar did not reveal in place at ${width}x${height}: ${JSON.stringify(sidebarMotion)}`
    );
    await delay(320);
    ensure(
      await rendererValue(`!document.querySelector(".editor-shell")?.classList.contains("sidebar-opening")`),
      "Editor sidebar entrance class did not clean itself up."
    );
    await rendererValue(`document.querySelector("#editorMoreButton")?.click()`);
    await waitForRenderer(`Boolean(document.querySelector(".editor-more-menu"))`, "workspace-menu parity surface");
    await verifyCurrentThemePair("Workspace menu", [".editor-more-menu", ".editor-more-section"], [".editor-more-section-title", ".editor-menu-state", ".editor-more-update small"]);
    const workspaceMenuMotion = await rendererValue(`getComputedStyle(document.querySelector(".editor-more-menu")).animationName`);
    ensure(workspaceMenuMotion.includes("localleaf-popover-in"), `Workspace menu did not use the restrained popover entrance: ${workspaceMenuMotion}`);
  }

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await waitForRenderer(
    `matchMedia("(prefers-reduced-motion: reduce)").matches`,
    "the reduced-motion media override"
  );
  const reducedMotion = await rendererValue(`(() => ({
    active: matchMedia("(prefers-reduced-motion: reduce)").matches,
    underlineDuration: getComputedStyle(document.querySelector(".file-button.active .file-label"), "::after").transitionDuration,
    quickSearchDuration: getComputedStyle(document.querySelector(".editor-search-launcher-surface"), "::before").transitionDuration,
    menuAnimation: getComputedStyle(document.querySelector(".editor-more-menu")).animationName,
    sidebarOpening: (() => {
      setSidebarVisible(false);
      setSidebarVisible(true);
      return document.querySelector(".editor-shell")?.classList.contains("sidebar-opening");
    })()
  }))()`);
  ensure(
    reducedMotion.active
      && reducedMotion.underlineDuration === "0s"
      && reducedMotion.quickSearchDuration === "0s"
      && reducedMotion.menuAnimation === "none"
      && !reducedMotion.sidebarOpening,
    `Reduced motion did not remove the interaction motion: ${JSON.stringify(reducedMotion)}`
  );

  await setEmulatedMediaFeatures([{ name: "forced-colors", value: "active" }]);
  await waitForRenderer(
    `matchMedia("(forced-colors: active)").matches`,
    "the forced-colors media override"
  );
  const forcedColors = await rendererValue(`(() => {
    const selectedBackground = getComputedStyle(document.querySelector(".file-button.active")).backgroundColor;
    const channels = (String(selectedBackground).match(/[\\d.]+/g) || []).map(Number);
    return {
      active: matchMedia("(forced-colors: active)").matches,
      avatarBorder: getComputedStyle(document.querySelector(".user-row .avatar")).borderStyle,
      quickSearchBorder: getComputedStyle(document.querySelector(".editor-search-launcher-surface"), "::before").borderStyle,
      selectedBackground,
      selectedBackgroundTransparent: selectedBackground === "transparent" || (channels.length > 3 && channels[3] === 0)
    };
  })()`);
  ensure(
    forcedColors.active
      && forcedColors.avatarBorder === "solid"
      && forcedColors.quickSearchBorder === "solid"
      && forcedColors.selectedBackgroundTransparent,
    `Forced colors lost avatar, search, or underline-only structure: ${JSON.stringify(forcedColors)}`
  );
  await setEmulatedMediaFeatures([]);

  smokeWindow.setContentSize(900, 640);
  await waitForRenderer(`innerWidth === 900 && innerHeight === 640`, "the minimum desktop search viewport");
  await rendererValue(`(() => {
    const input = document.querySelector("#editorQuickSearchInput");
    input?.focus();
    input?.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  })()`);
  await delay(430);
  const minimumDesktopSearch = await rendererValue(`(() => {
    const row = document.querySelector(".editor-format-row");
    const surface = document.querySelector(".editor-search-launcher-surface");
    const input = document.querySelector("#editorQuickSearchInput");
    const rowRect = row?.getBoundingClientRect();
    const surfaceRect = surface?.getBoundingClientRect();
    return {
      focused: document.activeElement === input,
      opacity: input ? getComputedStyle(input).opacity : "",
      contained: Boolean(rowRect && surfaceRect)
        && surfaceRect.left >= rowRect.left - 1
        && surfaceRect.right <= rowRect.right + 1
        && surfaceRect.left >= -1
        && surfaceRect.right <= innerWidth + 1,
      outerOverflowX: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1
    };
  })()`);
  ensure(
    minimumDesktopSearch.focused
      && Number(minimumDesktopSearch.opacity) >= 0.99
      && minimumDesktopSearch.contained
      && !minimumDesktopSearch.outerOverflowX,
    `The expanded editor search launcher escaped its 900px desktop viewport: ${JSON.stringify(minimumDesktopSearch)}`
  );
  await rendererValue(`document.querySelector("#editorQuickSearchInput")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  pass("editor quick search stays contained at the 900px minimum desktop width");

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
      theme: local.theme,
      sessionStatus: local.appState.session.status,
      inviteUrl: local.appState.session.inviteUrl
    };
    local.appState.session.status = "live";
    local.appState.session.inviteUrl = "https://example.com/localleaf/join";
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

  const quickActionsClosed = await rendererValue(`(() => {
    const trigger = document.querySelector("#chatSessionActionsButton");
    const menu = document.querySelector("#chatSessionActionsMenu");
    const composer = document.querySelector("#chatForm");
    const emptyMarkup = chatEmptyMarkup();
    return {
      triggerPresent: Boolean(trigger),
      triggerHeight: trigger?.getBoundingClientRect().height || 0,
      expanded: trigger?.getAttribute("aria-expanded") || "",
      controls: trigger?.getAttribute("aria-controls") || "",
      hasPopup: trigger?.getAttribute("aria-haspopup") || "",
      menuRole: menu?.getAttribute("role") || "",
      menuHidden: menu?.getAttribute("aria-hidden") || "",
      inert: Boolean(menu?.inert),
      itemCount: menu?.querySelectorAll('[role="menuitem"]').length || 0,
      labels: [...(menu?.querySelectorAll('[role="menuitem"]') || [])].map((item) => item.textContent.replace(/\\s+/g, " ").trim()),
      composerHeight: composer?.getBoundingClientRect().height || 0,
      structuredEmptyState: /chat-empty-title/.test(emptyMarkup) && /chat-empty-copy/.test(emptyMarkup)
    };
  })()`);
  ensure(
    quickActionsClosed.triggerPresent
      && Math.abs(quickActionsClosed.triggerHeight - 40) <= 1
      && quickActionsClosed.expanded === "false"
      && quickActionsClosed.controls === "chatSessionActionsMenu"
      && quickActionsClosed.hasPopup === "menu"
      && quickActionsClosed.menuRole === "menu"
      && quickActionsClosed.menuHidden === "true"
      && quickActionsClosed.inert
      && quickActionsClosed.itemCount === 2
      && quickActionsClosed.labels.join("|") === "Share link|Manage guests"
      && quickActionsClosed.composerHeight >= 56
      && quickActionsClosed.structuredEmptyState,
    `The Chat hierarchy or host quick-actions trigger is incomplete: ${JSON.stringify(quickActionsClosed)}`
  );

  await rendererValue(`document.querySelector("#chatSessionActionsButton")?.click()`);
  await waitForRenderer(
    `document.querySelector("#chatSessionActionsButton")?.getAttribute("aria-expanded") === "true" && document.activeElement?.matches?.('#chatSessionActionsMenu [role="menuitem"]') && Number.parseFloat(getComputedStyle(document.querySelector("#chatSessionActionsMenu")).opacity) >= 0.99`,
    "the Chat host quick-actions fan-out"
  );
  const quickActionsOpen = await rendererValue(`(() => {
    const trigger = document.querySelector("#chatSessionActionsButton");
    const menu = document.querySelector("#chatSessionActionsMenu");
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const menuStyle = getComputedStyle(menu);
    const itemStyle = getComputedStyle(items[0]);
    const chevronStyle = getComputedStyle(trigger.querySelector(".chat-session-actions-chevron"));
    return {
      expanded: trigger.getAttribute("aria-expanded"),
      menuHidden: menu.getAttribute("aria-hidden"),
      inert: menu.inert,
      focusedFirst: document.activeElement === items[0],
      menuTransition: menuStyle.transitionProperty,
      itemTransition: itemStyle.transitionProperty,
      menuDuration: menuStyle.transitionDuration,
      itemDuration: itemStyle.transitionDuration,
      chevronTransform: chevronStyle.transform,
      menuOpacity: menuStyle.opacity,
      menuTransform: menuStyle.transform
    };
  })()`);
  ensure(
    quickActionsOpen.expanded === "true"
      && quickActionsOpen.menuHidden === "false"
      && !quickActionsOpen.inert
      && quickActionsOpen.focusedFirst
      && quickActionsOpen.menuTransition.includes("transform")
      && quickActionsOpen.menuTransition.includes("opacity")
      && !quickActionsOpen.menuTransition.includes("all")
      && quickActionsOpen.itemTransition.includes("transform")
      && quickActionsOpen.itemTransition.includes("opacity")
      && !quickActionsOpen.itemTransition.includes("all")
      && quickActionsOpen.chevronTransform !== "none"
      && Number.parseFloat(quickActionsOpen.menuOpacity) >= 0.99,
    `The Chat host quick-actions menu lost its accessible, interruptible disclosure motion: ${JSON.stringify(quickActionsOpen)}`
  );

  await rendererValue(`(() => {
    const menu = document.querySelector("#chatSessionActionsMenu");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    return document.activeElement?.dataset.chatSessionAction || "";
  })()`);
  const quickActionsEndFocus = await rendererValue(`document.activeElement?.dataset.chatSessionAction || ""`);
  ensure(quickActionsEndFocus === "manage", "End did not move focus to Manage guests in the Chat quick-actions menu.");
  await rendererValue(`document.querySelector("#chatSessionActionsMenu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await waitForRenderer(
    `document.querySelector("#chatSessionActionsButton")?.getAttribute("aria-expanded") === "false" && document.activeElement?.id === "chatSessionActionsButton"`,
    "Chat quick-actions Escape focus restoration"
  );

  await rendererValue(`document.querySelector("#chatSessionActionsButton")?.click()`);
  await waitForRenderer(`document.querySelector("#chatSessionActionsButton")?.getAttribute("aria-expanded") === "true"`, "the reopened Chat quick-actions menu");
  await rendererValue(`document.querySelector('.chat-list')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await waitForRenderer(
    `document.querySelector("#chatSessionActionsButton")?.getAttribute("aria-expanded") === "false" && document.activeElement?.id === "chatSessionActionsButton"`,
    "Chat quick-actions outside-click focus restoration"
  );

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await rendererValue(`document.querySelector("#chatSessionActionsButton")?.click()`);
  await waitForRenderer(`document.querySelector("#chatSessionActionsButton")?.getAttribute("aria-expanded") === "true"`, "the reduced-motion Chat quick-actions menu");
  const quickActionsReducedMotion = await rendererValue(`(() => ({
    menu: getComputedStyle(document.querySelector("#chatSessionActionsMenu")).transitionDuration,
    item: getComputedStyle(document.querySelector('#chatSessionActionsMenu [role="menuitem"]')).transitionDuration,
    chevron: getComputedStyle(document.querySelector(".chat-session-actions-chevron")).transitionDuration
  }))()`);
  ensure(
    Number.parseFloat(quickActionsReducedMotion.menu) <= 0.00002
      && Number.parseFloat(quickActionsReducedMotion.item) <= 0.00002
      && Number.parseFloat(quickActionsReducedMotion.chevron) <= 0.00002,
    `Reduced motion did not disable the Chat quick-actions disclosure motion: ${JSON.stringify(quickActionsReducedMotion)}`
  );
  await rendererValue(`document.querySelector("#chatSessionActionsMenu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await setEmulatedMediaFeatures([]);

  await rendererValue(`(() => {
    const saved = window.__localLeafRenderedSmokeChatState;
    local.appState.session.status = saved.sessionStatus;
    local.appState.session.inviteUrl = saved.inviteUrl;
    document.querySelector("#chatSessionActionsButton")?.click();
    document.querySelector('[data-chat-session-action="manage"]')?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector(".session-share-page"))`, "Manage guests navigation from Chat");
  await rendererValue(`(() => { setView("editor"); return true; })()`);
  await waitForRenderer(`Boolean(document.querySelector(".editor-shell .chat-panel"))`, "the editor after Manage guests navigation");
  pass("host Chat quick actions expose Share and Manage guests with keyboard-safe disclosure motion");

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
    local.appState.session.status = saved.sessionStatus;
    local.appState.session.inviteUrl = saved.inviteUrl;
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

  await rendererValue(`document.querySelector("#editorStyleButton")?.click()`);
  await waitForRenderer(
    `(() => {
      const button = document.querySelector("#editorStyleButton");
      const menu = document.querySelector(".editor-style-menu");
      return button?.getAttribute("aria-expanded") === "true"
        && menu?.getAttribute("aria-hidden") === "false"
        && Number.parseFloat(getComputedStyle(menu).opacity) >= 0.99;
    })()`,
    "the editor text-style menu motion"
  );
  const editorStyleOpen = await rendererValue(`(() => {
    const menu = document.querySelector(".editor-style-menu");
    const chevron = document.querySelector(".style-chevron .tool-icon");
    return {
      mounted: Boolean(menu),
      inert: Boolean(menu?.inert),
      opacity: menu ? getComputedStyle(menu).opacity : "",
      chevronWidth: chevron ? getComputedStyle(chevron).width : "",
      chevronTransform: chevron ? getComputedStyle(chevron).transform : ""
    };
  })()`);
  ensure(
    editorStyleOpen.mounted
      && !editorStyleOpen.inert
      && Number.parseFloat(editorStyleOpen.opacity) >= 0.99
      && editorStyleOpen.chevronWidth === "18px"
      && editorStyleOpen.chevronTransform !== "none",
    `The editor text-style dropdown lost its persistent menu or chevron state: ${JSON.stringify(editorStyleOpen)}`
  );
  await rendererValue(`document.querySelector("#editorStyleButton")?.click()`);
  const editorStyleClosing = await rendererValue(`(() => {
    const menu = document.querySelector(".editor-style-menu");
    return {
      mounted: Boolean(menu),
      hidden: menu?.getAttribute("aria-hidden") || "",
      inert: Boolean(menu?.inert)
    };
  })()`);
  ensure(
    editorStyleClosing.mounted && editorStyleClosing.hidden === "true" && editorStyleClosing.inert,
    `The editor text-style menu was removed before its close transition: ${JSON.stringify(editorStyleClosing)}`
  );
  await waitForRenderer(
    `getComputedStyle(document.querySelector(".editor-style-menu")).visibility === "hidden"`,
    "the editor text-style menu close"
  );
  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await rendererValue(`document.querySelector("#editorStyleButton")?.click()`);
  const editorStyleReduced = await rendererValue(`(() => ({
    menu: getComputedStyle(document.querySelector(".editor-style-menu")).transitionDuration,
    chevron: getComputedStyle(document.querySelector(".style-chevron .tool-icon")).transitionDuration
  }))()`);
  ensure(
    Number.parseFloat(editorStyleReduced.menu) <= 0.00002
      && Number.parseFloat(editorStyleReduced.chevron) <= 0.00002,
    `Reduced motion did not make the text-style dropdown immediate: ${JSON.stringify(editorStyleReduced)}`
  );
  await rendererValue(`document.querySelector("#editorStyleButton")?.click()`);
  await setEmulatedMediaFeatures([]);
  pass("editor text-style dropdown stays mounted and animates only transform and opacity");

  const editorStyleKeyboard = await rendererValue(`(() => {
    const trigger = document.querySelector("#editorStyleButton");
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const first = document.activeElement;
    first?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const options = [...document.querySelectorAll(".editor-style-menu [role='menuitem']")];
    const lastFocused = document.activeElement === options.at(-1);
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return {
      firstFocused: first === options[0],
      lastFocused,
      expanded: trigger?.getAttribute("aria-expanded") || "",
      menuHidden: document.querySelector(".editor-style-menu")?.getAttribute("aria-hidden") || "",
      focused: document.activeElement === trigger
    };
  })()`);
  ensure(
    editorStyleKeyboard.firstFocused
      && editorStyleKeyboard.lastFocused
      && editorStyleKeyboard.expanded === "false"
      && editorStyleKeyboard.menuHidden === "true"
      && editorStyleKeyboard.focused,
    `The editor text-style menu lost Arrow/Home/End/Escape focus behavior: ${JSON.stringify(editorStyleKeyboard)}`
  );
  pass("editor text-style dropdown keeps keyboard focus within the ARIA menu and restores its trigger");

  const beforeDraft = await hostRequest(baseUrl, "/api/state");
  const beforeDraftPaths = new Set(beforeDraft.project.files.map((item) => item.path));
  await rendererValue(`document.querySelector("#newFile")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector(".tree-create-draft[data-create-kind='file']"))`, "the transactional new-file draft");
  const newFileDraft = await rendererValue(`(() => {
    const draft = document.querySelector(".tree-create-draft[data-create-kind='file']");
    const input = draft?.querySelector(".tree-create-input");
    const confirm = draft?.querySelector("[data-tree-create-confirm]");
    const cancel = draft?.querySelector("[data-tree-create-cancel]");
    return {
      value: input?.value || "",
      focused: document.activeElement === input,
      confirmLabel: confirm?.getAttribute("aria-label") || "",
      cancelLabel: cancel?.getAttribute("aria-label") || "",
      fileActionText: document.querySelector("#newFile")?.textContent?.replace(/\\s+/g, " ").trim() || "",
      folderActionText: document.querySelector("#newFolder")?.textContent?.replace(/\\s+/g, " ").trim() || ""
    };
  })()`);
  const afterOpenDraft = await hostRequest(baseUrl, "/api/state");
  ensure(
    newFileDraft.value === "untitled.tex"
      && newFileDraft.focused
      && newFileDraft.confirmLabel === "Create file"
      && newFileDraft.cancelLabel === "Cancel new file"
      && /New file/i.test(newFileDraft.fileActionText)
      && /New folder/i.test(newFileDraft.folderActionText),
    `The new-file draft is not clear or keyboard-ready: ${JSON.stringify(newFileDraft)}`
  );
  ensure(
    afterOpenDraft.project.files.length === beforeDraft.project.files.length
      && afterOpenDraft.project.files.every((item) => beforeDraftPaths.has(item.path)),
    "Opening New file wrote a placeholder to the project before confirmation."
  );

  await rendererValue(`(() => {
    const input = document.querySelector(".tree-create-input");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-tree-create-confirm]")?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector(".tree-create-error")?.textContent?.trim())`, "the inline new-file validation message");
  const invalidDraftState = await hostRequest(baseUrl, "/api/state");
  ensure(
    invalidDraftState.project.files.length === beforeDraft.project.files.length,
    "An invalid new-file draft created a ghost file."
  );

  await rendererValue(`(() => {
    const input = document.querySelector(".tree-create-input");
    input.value = "notes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-tree-create-confirm]")?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-file="notes.tex"].active')) && !document.querySelector(".tree-create-draft")`, "the committed new file");
  let createdState = await hostRequest(baseUrl, "/api/state");
  ensure(createdState.project.files.some((item) => item.path === "notes.tex"), "New file did not append the documented .tex default.");

  await rendererValue(`document.querySelector("#newFolder")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector(".tree-create-draft[data-create-kind='folder']"))`, "the transactional new-folder draft");
  await rendererValue(`(() => {
    const input = document.querySelector(".tree-create-input");
    input.value = "appendices";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-tree-create-confirm]")?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-folder="appendices"]')) && !document.querySelector(".tree-create-draft")`, "the committed new folder");
  createdState = await hostRequest(baseUrl, "/api/state");
  ensure(createdState.project.files.some((item) => item.path === "appendices" && item.type === "directory"), "New folder did not create the requested directory.");

  await rendererValue(`document.querySelector('[data-file="notes.tex"]')?.click()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-file="notes.tex"].active'))`, "the new file selection before rename");
  await rendererValue(`document.querySelector("#renameFile")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector('.tree-rename-input[data-rename-path="notes.tex"]'))`, "the full-name rename field");
  const renameDraft = await rendererValue(`(() => {
    const input = document.querySelector('.tree-rename-input[data-rename-path="notes.tex"]');
    return {
      value: input?.value || "",
      hasDetachedExtension: Boolean(input?.closest(".tree-rename-wrap")?.querySelector(".tree-rename-extension")),
      confirmLabel: input?.closest(".tree-rename-wrap")?.querySelector("[data-tree-rename-confirm]")?.getAttribute("aria-label") || "",
      cancelLabel: input?.closest(".tree-rename-wrap")?.querySelector("[data-tree-rename-cancel]")?.getAttribute("aria-label") || ""
    };
  })()`);
  ensure(
    renameDraft.value === "notes.tex"
      && !renameDraft.hasDetachedExtension
      && renameDraft.confirmLabel === "Save new name"
      && renameDraft.cancelLabel === "Cancel rename",
    `Rename still hides the file extension or lacks explicit actions: ${JSON.stringify(renameDraft)}`
  );
  await rendererValue(`(() => {
    const input = document.querySelector('.tree-rename-input[data-rename-path="notes.tex"]');
    input.value = "analysis.tex";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest(".tree-rename-wrap")?.querySelector("[data-tree-rename-confirm]")?.click();
    return true;
  })()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-file="analysis.tex"].active'))`, "the explicit rename commit");
  const renamedState = await hostRequest(baseUrl, "/api/state");
  ensure(
    renamedState.project.files.some((item) => item.path === "analysis.tex")
      && !renamedState.project.files.some((item) => item.path === "notes.tex"),
    "The full-name rename did not update the project atomically."
  );

  await rendererValue(`document.querySelector("#newFile")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector(".tree-create-draft"))`, "the cancellable creation draft");
  await rendererValue(`document.querySelector("[data-tree-create-cancel]")?.click()`);
  await waitForRenderer(`!document.querySelector(".tree-create-draft")`, "the cancelled creation draft");
  const afterCancelState = await hostRequest(baseUrl, "/api/state");
  ensure(afterCancelState.project.files.length === renamedState.project.files.length, "Cancelling New file left a placeholder behind.");

  await rendererValue(`document.querySelector('[data-file="main.tex"]')?.click()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-file="main.tex"].active'))`, "the restored main-file selection");
  pass("file and folder creation stays transactional and full-name rename is explicit");

  await rendererValue(`(() => {
    window.__localLeafDeleteDialogNativeCalls = { confirm: 0, alert: 0 };
    window.__localLeafDeleteDialogOriginalConfirm = window.confirm;
    window.__localLeafDeleteDialogOriginalAlert = window.alert;
    window.confirm = () => {
      window.__localLeafDeleteDialogNativeCalls.confirm += 1;
      return false;
    };
    window.alert = () => {
      window.__localLeafDeleteDialogNativeCalls.alert += 1;
    };
    return true;
  })()`);

  await rendererValue(`document.querySelector('[data-folder="appendices"]')?.click()`);
  await waitForRenderer(`local.selectedFolder === "appendices"`, "the folder selected for delete confirmation");
  await rendererValue(`document.querySelector("#deleteFile")?.click()`);
  await waitForRenderer(
    `Boolean(document.querySelector(".file-delete-dialog")) && document.activeElement?.id === "cancelFileDelete"`,
    "the folder delete confirmation and initial Cancel focus"
  );
  const folderDeleteDialog = await rendererValue(`(() => {
    const dialog = document.querySelector(".file-delete-dialog");
    const cancel = dialog?.querySelector("#cancelFileDelete");
    const confirm = dialog?.querySelector("#confirmFileDelete");
    const title = dialog?.querySelector("#fileDeleteTitle");
    const actionStyle = confirm && getComputedStyle(confirm);
    const cancelStyle = cancel && getComputedStyle(cancel);
    const dialogStyle = dialog && getComputedStyle(dialog);
    const titleStyle = title && getComputedStyle(title);
    const initialFocus = document.activeElement === cancel;
    cancel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    const wrapsBackward = document.activeElement === confirm;
    confirm?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const wrapsForward = document.activeElement === cancel;
    return {
      role: dialog?.getAttribute("role") || "",
      ariaModal: dialog?.getAttribute("aria-modal") || "",
      labelledBy: dialog?.getAttribute("aria-labelledby") || "",
      describedBy: dialog?.getAttribute("aria-describedby") || "",
      title: title?.textContent?.trim() || "",
      type: dialog?.querySelector(".file-delete-target-type")?.textContent?.trim() || "",
      name: dialog?.querySelector(".file-delete-target-name")?.textContent?.trim() || "",
      confirmText: confirm?.textContent?.trim() || "",
      initialFocus,
      wrapsBackward,
      wrapsForward,
      iconFree: !dialog?.querySelector("svg, .ui-glyph, .tool-icon"),
      dialogRadius: dialogStyle?.borderRadius || "",
      dialogBackground: dialogStyle?.backgroundColor || "",
      titleSize: titleStyle?.fontSize || "",
      cancelHeight: cancel?.getBoundingClientRect().height || 0,
      confirmHeight: confirm?.getBoundingClientRect().height || 0,
      cancelBackground: cancelStyle?.backgroundColor || "",
      actionBackground: actionStyle?.backgroundColor || "",
      actionColor: actionStyle?.color || ""
    };
  })()`);
  ensure(
    folderDeleteDialog.role === "alertdialog"
      && folderDeleteDialog.ariaModal === "true"
      && folderDeleteDialog.labelledBy === "fileDeleteTitle"
      && folderDeleteDialog.describedBy.includes("fileDeleteDescription")
      && folderDeleteDialog.describedBy.includes("fileDeleteTarget")
      && folderDeleteDialog.title === "Delete folder?"
      && folderDeleteDialog.type === "Folder"
      && folderDeleteDialog.name === "appendices"
      && folderDeleteDialog.confirmText === "Delete folder"
      && folderDeleteDialog.initialFocus
      && folderDeleteDialog.wrapsBackward
      && folderDeleteDialog.wrapsForward
      && folderDeleteDialog.iconFree
      && folderDeleteDialog.dialogRadius === "24px"
      && folderDeleteDialog.dialogBackground === "rgb(255, 255, 255)"
      && folderDeleteDialog.titleSize === "18px"
      && Math.abs(folderDeleteDialog.cancelHeight - 40) <= 1
      && Math.abs(folderDeleteDialog.confirmHeight - 40) <= 1
      && folderDeleteDialog.cancelBackground === "rgb(255, 255, 255)"
      && folderDeleteDialog.actionBackground === "rgb(180, 35, 24)"
      && folderDeleteDialog.actionColor === "rgb(255, 255, 255)",
    `The folder delete dialog lost its LocalLeaf structure, semantic red action, or focus contract: ${JSON.stringify(folderDeleteDialog)}`
  );
  await rendererValue(`document.querySelector(".file-delete-backdrop")?.click()`);
  await waitForRenderer(
    `!document.querySelector(".file-delete-backdrop") && document.activeElement?.id === "deleteFile"`,
    "overlay cancellation and focus restoration"
  );

  await rendererValue(`document.querySelector('[data-file="analysis.tex"]')?.click()`);
  await waitForRenderer(`Boolean(document.querySelector('[data-file="analysis.tex"].active'))`, "the file selected for delete confirmation");
  await rendererValue(`document.querySelector("#deleteFile")?.click()`);
  await waitForRenderer(
    `Boolean(document.querySelector(".file-delete-dialog")) && document.activeElement?.id === "cancelFileDelete"`,
    "the file delete confirmation"
  );
  const deleteThemePair = await rendererValue(`(() => {
    const capture = () => {
      const dialog = document.querySelector(".file-delete-dialog");
      const target = dialog?.querySelector(".file-delete-target");
      const action = dialog?.querySelector("#confirmFileDelete");
      return {
        dialogBackground: dialog ? getComputedStyle(dialog).backgroundColor : "",
        targetBackground: target ? getComputedStyle(target).backgroundColor : "",
        actionBackground: action ? getComputedStyle(action).backgroundColor : "",
        actionColor: action ? getComputedStyle(action).color : ""
      };
    };
    const light = capture();
    applyTheme("dark");
    const dark = capture();
    applyTheme("light");
    return {
      light,
      dark,
      title: document.querySelector("#fileDeleteTitle")?.textContent?.trim() || "",
      type: document.querySelector(".file-delete-target-type")?.textContent?.trim() || "",
      name: document.querySelector(".file-delete-target-name")?.textContent?.trim() || "",
      action: document.querySelector("#confirmFileDelete")?.textContent?.trim() || ""
    };
  })()`);
  ensure(
    deleteThemePair.title === "Delete file?"
      && deleteThemePair.type === "File"
      && deleteThemePair.name === "analysis.tex"
      && deleteThemePair.action === "Delete file"
      && deleteThemePair.light.dialogBackground === "rgb(255, 255, 255)"
      && deleteThemePair.light.targetBackground === "rgb(251, 251, 250)"
      && deleteThemePair.dark.dialogBackground === "rgb(23, 24, 22)"
      && deleteThemePair.dark.targetBackground === "rgb(28, 29, 26)"
      && deleteThemePair.light.actionBackground === "rgb(180, 35, 24)"
      && deleteThemePair.dark.actionBackground === "rgb(180, 35, 24)"
      && deleteThemePair.light.actionColor === "rgb(255, 255, 255)"
      && deleteThemePair.dark.actionColor === "rgb(255, 255, 255)",
    `The delete dialog lost its light/dark neutral surface or red destructive action: ${JSON.stringify(deleteThemePair)}`
  );
  await rendererValue(`document.querySelector(".file-delete-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await waitForRenderer(
    `!document.querySelector(".file-delete-backdrop") && document.activeElement?.id === "deleteFile"`,
    "Escape cancellation and focus restoration"
  );

  await setEmulatedMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await rendererValue(`document.querySelector("#deleteFile")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector(".file-delete-dialog"))`, "the reduced-motion delete dialog");
  const deleteReducedMotion = await rendererValue(`(() => ({
    active: matchMedia("(prefers-reduced-motion: reduce)").matches,
    backdropAnimation: getComputedStyle(document.querySelector(".file-delete-backdrop")).animationName,
    dialogAnimation: getComputedStyle(document.querySelector(".file-delete-dialog")).animationName,
    actionTransition: getComputedStyle(document.querySelector("#confirmFileDelete")).transitionDuration
  }))()`);
  ensure(
    deleteReducedMotion.active
      && deleteReducedMotion.backdropAnimation === "none"
      && deleteReducedMotion.dialogAnimation === "none"
      && deleteReducedMotion.actionTransition === "0s",
    `Reduced motion did not remove delete-dialog animation: ${JSON.stringify(deleteReducedMotion)}`
  );
  await rendererValue(`document.querySelector("#cancelFileDelete")?.click()`);
  await waitForRenderer(`!document.querySelector(".file-delete-backdrop")`, "the reduced-motion delete dialog closing");
  await setEmulatedMediaFeatures([]);

  await setEmulatedMediaFeatures([{ name: "forced-colors", value: "active" }]);
  await rendererValue(`document.querySelector("#deleteFile")?.click()`);
  await waitForRenderer(`Boolean(document.querySelector(".file-delete-dialog"))`, "the forced-colors delete dialog");
  const deleteForcedColors = await rendererValue(`(() => {
    const dialog = document.querySelector(".file-delete-dialog");
    const target = document.querySelector(".file-delete-target");
    const action = document.querySelector("#confirmFileDelete");
    const actionStyle = getComputedStyle(action);
    return {
      active: matchMedia("(forced-colors: active)").matches,
      dialogBorder: getComputedStyle(dialog).borderStyle,
      targetBorder: getComputedStyle(target).borderStyle,
      actionBorder: actionStyle.borderStyle,
      actionBackground: actionStyle.backgroundColor,
      actionColor: actionStyle.color
    };
  })()`);
  ensure(
    deleteForcedColors.active
      && deleteForcedColors.dialogBorder === "solid"
      && deleteForcedColors.targetBorder === "solid"
      && deleteForcedColors.actionBorder === "solid"
      && deleteForcedColors.actionBackground !== "rgb(180, 35, 24)"
      && deleteForcedColors.actionBackground !== deleteForcedColors.actionColor,
    `Forced colors did not retain delete-dialog structure and action contrast: ${JSON.stringify(deleteForcedColors)}`
  );
  await rendererValue(`document.querySelector("#cancelFileDelete")?.click()`);
  await waitForRenderer(`!document.querySelector(".file-delete-backdrop")`, "the forced-colors delete dialog closing");
  await setEmulatedMediaFeatures([]);

  await rendererValue(`(() => {
    window.__localLeafDeleteDialogOriginalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes("/api/file/delete")) {
        return new Promise((resolve) => {
          window.__localLeafDeleteDialogResolve = resolve;
        });
      }
      return window.__localLeafDeleteDialogOriginalFetch(input, init);
    };
    document.querySelector("#deleteFile")?.click();
    return true;
  })()`);
  await waitForRenderer(`document.activeElement?.id === "cancelFileDelete"`, "the retryable delete dialog");
  await rendererValue(`document.querySelector("#confirmFileDelete")?.click()`);
  await waitForRenderer(`document.querySelector(".file-delete-backdrop")?.dataset.busy === "true"`, "the pending delete state");
  const deletePendingState = await rendererValue(`(() => {
    const modal = document.querySelector(".file-delete-backdrop");
    const dialog = document.querySelector(".file-delete-dialog");
    const cancel = document.querySelector("#cancelFileDelete");
    const action = document.querySelector("#confirmFileDelete");
    const status = document.querySelector("#fileDeleteStatus");
    modal?.click();
    modal?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return {
      remainsOpen: Boolean(document.querySelector(".file-delete-backdrop")),
      busy: modal?.dataset.busy || "",
      ariaBusy: dialog?.getAttribute("aria-busy") || "",
      cancelDisabled: Boolean(cancel?.disabled),
      actionDisabled: Boolean(action?.disabled),
      actionText: action?.textContent?.trim() || "",
      statusText: status?.textContent?.trim() || "",
      statusHidden: Boolean(status?.hidden)
    };
  })()`);
  ensure(
    deletePendingState.remainsOpen
      && deletePendingState.busy === "true"
      && deletePendingState.ariaBusy === "true"
      && deletePendingState.cancelDisabled
      && deletePendingState.actionDisabled
      && deletePendingState.actionText === "Deleting..."
      && deletePendingState.statusText === "Deleting file..."
      && !deletePendingState.statusHidden,
    `The pending delete state is not stable or clearly labelled: ${JSON.stringify(deletePendingState)}`
  );
  await rendererValue(`(() => {
    window.__localLeafDeleteDialogResolve?.(new Response(
      JSON.stringify({ error: "Rendered delete denied." }),
      { status: 409, headers: { "content-type": "application/json" } }
    ));
    return true;
  })()`);
  await waitForRenderer(
    `document.querySelector("#fileDeleteStatus")?.textContent?.trim() === "Rendered delete denied."`,
    "the in-dialog delete server error"
  );
  const deleteErrorState = await rendererValue(`(() => {
    const modal = document.querySelector(".file-delete-backdrop");
    const status = document.querySelector("#fileDeleteStatus");
    const cancel = document.querySelector("#cancelFileDelete");
    const action = document.querySelector("#confirmFileDelete");
    return {
      remainsOpen: Boolean(modal),
      busy: modal?.dataset.busy || "",
      role: status?.getAttribute("role") || "",
      ariaLive: status?.getAttribute("aria-live") || "",
      statusText: status?.textContent?.trim() || "",
      cancelEnabled: !cancel?.disabled,
      actionEnabled: !action?.disabled,
      actionText: action?.textContent?.trim() || "",
      actionFocused: document.activeElement === action,
      nativeCalls: { ...window.__localLeafDeleteDialogNativeCalls }
    };
  })()`);
  ensure(
    deleteErrorState.remainsOpen
      && deleteErrorState.busy === "false"
      && deleteErrorState.role === "alert"
      && deleteErrorState.ariaLive === "assertive"
      && deleteErrorState.statusText === "Rendered delete denied."
      && deleteErrorState.cancelEnabled
      && deleteErrorState.actionEnabled
      && deleteErrorState.actionText === "Delete file"
      && deleteErrorState.actionFocused
      && deleteErrorState.nativeCalls.confirm === 0
      && deleteErrorState.nativeCalls.alert === 0,
    `A delete server error escaped the dialog or invoked a native prompt: ${JSON.stringify(deleteErrorState)}`
  );
  await rendererValue(`(() => {
    window.fetch = window.__localLeafDeleteDialogOriginalFetch;
    delete window.__localLeafDeleteDialogOriginalFetch;
    delete window.__localLeafDeleteDialogResolve;
    document.querySelector("#cancelFileDelete")?.click();
    return true;
  })()`);
  await waitForRenderer(
    `!document.querySelector(".file-delete-backdrop") && document.activeElement?.id === "deleteFile"`,
    "error-dialog cancellation and focus restoration"
  );

  await rendererValue(`document.querySelector("#deleteFile")?.click()`);
  await waitForRenderer(`document.activeElement?.id === "cancelFileDelete"`, "the final file delete confirmation");
  await rendererValue(`document.querySelector("#confirmFileDelete")?.click()`);
  await waitForRenderer(
    `!document.querySelector(".file-delete-backdrop") && !document.querySelector('[data-file="analysis.tex"]') && document.activeElement?.id === "deleteFile"`,
    "the completed file deletion and delete-trigger focus restoration"
  );
  const deletedState = await hostRequest(baseUrl, "/api/state");
  ensure(!deletedState.project.files.some((item) => item.path === "analysis.tex"), "The confirmed file deletion did not reach the host project.");
  const deleteNativeCalls = await rendererValue(`(() => {
    const calls = { ...window.__localLeafDeleteDialogNativeCalls };
    window.confirm = window.__localLeafDeleteDialogOriginalConfirm;
    window.alert = window.__localLeafDeleteDialogOriginalAlert;
    delete window.__localLeafDeleteDialogNativeCalls;
    delete window.__localLeafDeleteDialogOriginalConfirm;
    delete window.__localLeafDeleteDialogOriginalAlert;
    return calls;
  })()`);
  ensure(
    deleteNativeCalls.confirm === 0 && deleteNativeCalls.alert === 0,
    `File deletion invoked a native confirm/alert: ${JSON.stringify(deleteNativeCalls)}`
  );
  pass("file deletion uses a focus-managed LocalLeaf dialog across cancel, pending, error, and success states");

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
  const changesActions = await rendererValue(`(() => {
    const run = document.querySelector('[data-ai-run="rendered-review-run"]');
    const undo = run?.querySelector('.ai-run-undo-action');
    const review = run?.querySelector('.ai-run-review-action');
    const disclosure = run?.querySelector('.ai-run-disclosure');
    const reviewUnderline = review ? getComputedStyle(review, "::after") : null;
    return {
      undoBorder: undo ? getComputedStyle(undo).borderTopWidth : "",
      undoBackground: undo ? getComputedStyle(undo).backgroundColor : "",
      reviewBorder: review ? getComputedStyle(review).borderTopWidth : "",
      reviewBackground: review ? getComputedStyle(review).backgroundColor : "",
      disclosureBorder: disclosure ? getComputedStyle(disclosure).borderTopWidth : "",
      disclosureBackground: disclosure ? getComputedStyle(disclosure).backgroundColor : "",
      underlineColor: reviewUnderline?.backgroundColor || "",
      hasUndoIcon: Boolean(undo?.querySelector('.tool-icon-undo')),
      hasReviewIcon: Boolean(review?.querySelector('.tool-icon-review')),
      hasDisclosureIcon: Boolean(disclosure?.querySelector('.tool-icon-chevronDown')),
      reviewLabel: review?.textContent?.trim() || "",
      disclosureExpanded: disclosure?.getAttribute('aria-expanded') || ""
    };
  })()`);
  ensure(
    changesActions.undoBorder === "0px"
      && changesActions.undoBackground === "rgba(0, 0, 0, 0)"
      && changesActions.reviewBorder === "0px"
      && changesActions.reviewBackground === "rgba(0, 0, 0, 0)"
      && changesActions.disclosureBorder === "0px"
      && changesActions.disclosureBackground === "rgba(0, 0, 0, 0)"
      && changesActions.underlineColor === "rgb(201, 81, 0)"
      && changesActions.hasUndoIcon
      && changesActions.hasReviewIcon
      && changesActions.hasDisclosureIcon
      && changesActions.reviewLabel === "Review"
      && changesActions.disclosureExpanded === "false",
    `Changes retained boxed or inaccessible run actions: ${JSON.stringify(changesActions)}`
  );
  await moveTrustedPointerTo('[data-review-ai-run="rendered-review-run"]');
  await waitForRenderer(
    `getComputedStyle(document.querySelector('[data-review-ai-run="rendered-review-run"]'), "::after").opacity === "1"`,
    "the Changes Review underline interaction"
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
      disclosureTransform: disclosure?.querySelector('.tool-icon-chevronDown') ? getComputedStyle(disclosure.querySelector('.tool-icon-chevronDown')).transform : '',
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
      && reviewNavigation.disclosureTransform !== "none"
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

async function testGuestManagementAndViewerAccess(baseUrl) {
  const waitForServerState = async (predicate, label) => {
    const deadline = Date.now() + CONDITION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`${label} did not become ready within ${CONDITION_TIMEOUT_MS}ms.`);
  };
  const postJson = async (route, body) => {
    const response = await fetch(new URL(route, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    ensure(response.ok, `${route} failed with HTTP ${response.status}: ${payload.error || "unknown error"}`);
    return payload;
  };

  if (hostServer.state.session.status === "live") {
    await hostRequest(baseUrl, "/api/session/stop", { method: "POST", body: {} });
  }
  const started = await hostRequest(baseUrl, "/api/session/start", { method: "POST", body: {} });
  const join = await postJson("/api/join", { name: "Viewer Smoke", code: started.session.code });

  await smokeWindow.loadURL(`${baseUrl}/?view=session&host=${encodeURIComponent(hostToken)}`);
  await installRendererErrorCapture();
  await waitForRenderer(`document.querySelector('[data-session-guest-approve="${join.requestId}"]')`, "the pending guest row");
  const manager = await rendererValue(`(() => {
    const heading = document.querySelector("#sessionGuestsHeading");
    const host = document.querySelector(".session-host-row");
    const picker = document.querySelector('[data-session-role-picker][data-role-context="pending"]');
    const trigger = picker?.querySelector(".session-role-trigger");
    const menu = picker?.querySelector(".session-role-menu");
    return {
      hostSeparate: Boolean(host) && !host.closest("[data-session-guest-row]"),
      count: heading?.parentElement?.textContent || "",
      defaultRole: picker?.dataset.roleValue || "",
      triggerHeight: trigger ? Math.round(trigger.getBoundingClientRect().height) : 0,
      expanded: trigger?.getAttribute("aria-expanded"),
      menuHidden: menu?.hasAttribute("inert") && menu?.getAttribute("aria-hidden") === "true"
    };
  })()`);
  ensure(manager.hostSeparate, "The host was not presented separately from admitted guests.");
  ensure(manager.count.includes("0 of 5"), "The guest capacity count included the host.");
  ensure(manager.defaultRole === "viewer", "A pending guest did not default to Viewer.");
  ensure(manager.triggerHeight === 40 && manager.expanded === "false" && manager.menuHidden, "The role picker did not expose the canonical closed 40px control.");
  const roleKeyboard = await rendererValue(`(() => {
    const picker = document.querySelector('[data-session-role-picker][data-role-context="pending"]');
    const trigger = picker?.querySelector('.session-role-trigger');
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const optionFocused = document.activeElement?.matches?.('[data-session-role-option="viewer"]') || false;
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { optionFocused, triggerRestored: document.activeElement === trigger, expanded: trigger?.getAttribute('aria-expanded') };
  })()`);
  ensure(roleKeyboard.optionFocused && roleKeyboard.triggerRestored && roleKeyboard.expanded === "false", "The role picker did not preserve keyboard focus through open and Escape.");

  await rendererValue(`document.querySelector('[data-session-guest-approve="${join.requestId}"]')?.click()`);
  await waitForServerState(
    () => hostServer.state.session.joinRequests.find((item) => item.id === join.requestId)?.status === "approved",
    "the Viewer approval"
  );
  const approvedRequest = hostServer.state.session.joinRequests.find((item) => item.id === join.requestId);
  const guestId = approvedRequest.userId;
  ensure(approvedRequest.role === "viewer", "The approval request did not submit the selected Viewer role.");
  pass("Session guest count and Viewer-default approval are authoritative");

  await waitForRenderer(`document.querySelector('[data-session-role-picker][data-role-context="guest"][data-role-id="${guestId}"]')`, "the connected guest role picker");
  await rendererValue(`(() => {
    const picker = document.querySelector('[data-session-role-picker][data-role-context="guest"][data-role-id="${guestId}"]');
    picker?.querySelector(".session-role-trigger")?.click();
    picker?.querySelector('[data-session-role-option="maintainer"]')?.click();
    return true;
  })()`);
  await waitForServerState(
    () => hostServer.state.session.users.find((item) => item.id === guestId)?.role === "maintainer",
    "the live Maintainer role change"
  );
  await waitForRenderer(
    `document.activeElement?.matches?.('[data-session-role-picker][data-role-context="guest"][data-role-id="${guestId}"] .session-role-trigger') || false`,
    "role picker focus restoration"
  );
  await hostRequest(baseUrl, "/api/session/guest/role", { method: "POST", body: { userId: guestId, role: "viewer" } });
  pass("Connected guest role picker updates access pessimistically");

  await rendererValue(`(() => { setView("editor"); return true; })()`);
  await waitForRenderer(`document.querySelector("#chatSessionActionsButton")`, "the host Chat quick actions");
  await rendererValue(`(() => {
    document.querySelector("#chatSessionActionsButton")?.click();
    document.querySelector('[data-chat-session-action="manage"]')?.click();
    return true;
  })()`);
  await waitForRenderer(`route().view === "session" && document.activeElement?.id === "sessionGuestsHeading"`, "the focused Session guest manager");
  pass("Chat Manage guests focuses the authoritative guest manager");

  const joinStatusResponse = await fetch(new URL(`/api/join-status?id=${encodeURIComponent(join.requestId)}`, baseUrl));
  const joinStatus = await joinStatusResponse.json();
  ensure(joinStatusResponse.ok && joinStatus.token, "The approved Viewer token was unavailable.");
  await rendererValue(`(() => {
    sessionStorage.removeItem("localleaf.hostToken");
    sessionStorage.removeItem("localleaf.guestToken");
    return true;
  })()`);
  await smokeWindow.loadURL(`${baseUrl}/?view=editor&token=${encodeURIComponent(joinStatus.token)}&name=${encodeURIComponent("Viewer Smoke")}`);
  await installRendererErrorCapture();
  await waitForRenderer(`route().view === "editor" && local.userId === ${JSON.stringify(guestId)} && document.querySelector(".cm-content")`, "the Viewer editor");
  await rendererValue(`openEditorSearchPanel()`);
  await waitForRenderer(`Boolean(document.querySelector("#replaceAll"))`, "the Viewer search panel");
  const viewerAccess = await rendererValue(`(() => {
    const before = local.editorContent;
    markEditorChanged("viewer-mutation-must-not-apply");
    return {
      role: effectiveSessionRole(),
      canEdit: canMutateProject(),
      contentEditable: document.querySelector(".cm-content")?.getAttribute("contenteditable"),
      saveDisabled: Boolean(document.querySelector("#saveButton")?.disabled),
      fileToolsDisabled: ["#newFile", "#newFolder", "#uploadFile", "#renameFile", "#deleteFile"].every((selector) => document.querySelector(selector)?.disabled),
      formatDisabled: [...document.querySelectorAll("[data-editor-command]")].every((button) => button.disabled),
      replaceDisabled: Boolean(document.querySelector("#replaceAll")?.disabled),
      aiDisabled: Boolean(document.querySelector("#aiPrompt")?.disabled && document.querySelector(".ai-send-button")?.disabled),
      mutationBlocked: local.editorContent === before
    };
  })()`);
  ensure(viewerAccess.role === "viewer" && !viewerAccess.canEdit, "The Viewer identity was not derived from the approved user.");
  ensure(viewerAccess.contentEditable !== "true" && viewerAccess.saveDisabled, "The CodeMirror surface or Save control remained editable for a Viewer.");
  ensure(viewerAccess.fileToolsDisabled && viewerAccess.formatDisabled && viewerAccess.replaceDisabled && viewerAccess.aiDisabled, "A project mutation control remained available to a Viewer.");
  ensure(viewerAccess.mutationBlocked, "The Viewer mutation guard accepted a local editor change.");

  await rendererValue(`document.querySelector('[data-file="mapped.tex"]')?.click()`);
  await waitForRenderer(`local.selectedFile === "mapped.tex" && currentEditorText().includes("Mapped source line")`, "Viewer source navigation");
  pass("Viewer can read and switch files while mutation controls stay locked");

  await hostRequest(baseUrl, "/api/session/guest/role", { method: "POST", body: { userId: guestId, role: "maintainer" } });
  await waitForRenderer(`effectiveSessionRole() === "maintainer" && !document.querySelector("#saveButton")?.disabled && document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true"`, "the live Viewer-to-Maintainer upgrade");
  await hostRequest(baseUrl, "/api/session/guest/role", { method: "POST", body: { userId: guestId, role: "viewer" } });
  await waitForRenderer(`effectiveSessionRole() === "viewer" && document.querySelector("#saveButton")?.disabled && document.querySelector(".cm-content")?.getAttribute("contenteditable") !== "true"`, "the live Maintainer-to-Viewer downgrade");
  pass("Live role upgrades and downgrades remount the editor without reconnecting");

  await rendererValue(`(() => {
    sessionStorage.removeItem("localleaf.guestToken");
    sessionStorage.removeItem("localleaf.hostToken");
    return true;
  })()`);
  await smokeWindow.loadURL(`${baseUrl}/?view=session&host=${encodeURIComponent(hostToken)}`);
  await installRendererErrorCapture();
  await waitForRenderer(`document.querySelector('[data-session-guest-remove="${guestId}"]')`, "the connected guest removal action");
  await rendererValue(`document.querySelector('[data-session-guest-remove="${guestId}"]')?.click()`);
  const removeDialog = await rendererValue(`(() => ({
    role: document.querySelector(".guest-remove-dialog")?.getAttribute("role"),
    cancelFocused: document.activeElement?.matches?.("[data-cancel-guest-remove]") || false
  }))()`);
  ensure(removeDialog.role === "alertdialog" && removeDialog.cancelFocused, "Guest removal did not use the LocalLeaf alert dialog with safe initial focus.");
  await rendererValue(`document.querySelector("[data-confirm-guest-remove]")?.click()`);
  await waitForServerState(
    () => !hostServer.state.session.users.some((item) => item.id === guestId),
    "the guest removal"
  );
  await waitForRenderer(`!document.querySelector('[data-session-guest-remove="${guestId}"]')`, "the removed guest row");
  pass("Guest removal revokes access from a focused confirmation dialog");

  const removedBeforePollJoin = await postJson("/api/join", {
    name: "Removed Before Poll",
    code: hostServer.state.session.code
  });
  const removedBeforePollApproval = await hostRequest(baseUrl, "/api/join/approve", {
    method: "POST",
    body: { requestId: removedBeforePollJoin.requestId }
  });
  await hostRequest(baseUrl, "/api/session/guest/remove", {
    method: "POST",
    body: { userId: removedBeforePollApproval.user.id }
  });
  await rendererValue(`(() => {
    local.hostToken = "";
    local.guestToken = "";
    local.userId = "";
    sessionStorage.removeItem("localleaf.hostToken");
    sessionStorage.removeItem("localleaf.guestToken");
    local.joinRequestId = ${JSON.stringify(removedBeforePollJoin.requestId)};
    local.userName = "Removed Before Poll";
    renderWaiting();
    void pollJoinStatus();
    return true;
  })()`);
  await waitForRenderer(
    `route().view === "ended" && /removed your access/i.test(local.sessionEndedReason || "")`,
    "the terminal removed-before-poll state"
  );
  pass("Removed approval cannot leave a guest polling forever");

  const pageErrors = await rendererValue(`window.__localLeafRenderedSmokeErrors || []`);
  ensure(Array.isArray(pageErrors) && pageErrors.length === 0, `The guest-management renderer reported an uncaught error: ${pageErrors?.[0] || "unknown"}`);
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
  await testGuestManagementAndViewerAccess(baseUrl);
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
