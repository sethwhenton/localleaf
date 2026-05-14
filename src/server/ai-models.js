const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");

const MODEL_FOLDER_NAME = "LocalLeafModel";
const PROVIDERS_FILE = "providers.json";
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const DEFAULT_TEST_TIMEOUT_MS = 25000;
const DEFAULT_GENERATION_TIMEOUT_MS = 120000;
const ROOT_DIR = path.resolve(__dirname, "../..");
const LLAMA_SERVER_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server";

const MODEL_CATALOG = [
  {
    id: "qwen35-08b-light",
    name: "Qwen2.5 0.5B Light",
    sizeLabel: "333 MB",
    parameterLabel: "0.5B",
    filename: "Qwen2.5-0.5B-Instruct-IQ4_XS.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-IQ4_XS.gguf?download=true",
    expectedBytes: 349402688,
    description: "Small local GGUF model for quick LaTeX edits on modest laptops."
  },
  {
    id: "qwen35-2b-recommended",
    name: "Qwen2.5 Coder 0.5B Recommended",
    sizeLabel: "379 MB",
    parameterLabel: "0.5B",
    filename: "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf",
    downloadUrl: "https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf?download=true",
    expectedBytes: 397808288,
    description: "Coder-tuned local GGUF model for LaTeX edits and structured code blocks."
  }
];

const PROVIDER_TEMPLATES = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
    description: "OpenCode Go preset with fast coding-capable models.",
    requiresApiKey: true,
    recommended: true,
    models: [
      { id: "kimi-k2.6", name: "Kimi K2.6" },
      { id: "glm-5.1", name: "GLM 5.1" }
    ],
    headers: {}
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    description: "Use your OpenAI API key with an OpenAI-compatible endpoint.",
    requiresApiKey: true,
    models: [
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gpt-4.1", name: "GPT-4.1" }
    ],
    headers: {}
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    description: "Use one OpenRouter key with many hosted models.",
    requiresApiKey: true,
    models: [
      { id: "qwen/qwen3-coder", name: "Qwen Coder" },
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet" }
    ],
    headers: {
      "HTTP-Referer": "https://sethwhenton.github.io/localleaf/",
      "X-Title": "LocalLeaf"
    }
  },
  {
    id: "ollama",
    name: "Ollama",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    description: "Connect to a local Ollama server. API key is optional.",
    requiresApiKey: false,
    models: [
      { id: "qwen2.5-coder:1.5b", name: "Qwen Coder 1.5B" },
      { id: "llama3.2:3b", name: "Llama 3.2 3B" }
    ],
    headers: {}
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    type: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    description: "Connect to LM Studio's local OpenAI-compatible server.",
    requiresApiKey: false,
    models: [
      { id: "local-model", name: "Loaded LM Studio Model" }
    ],
    headers: {}
  },
  {
    id: "cursor",
    name: "Cursor",
    type: "cursor-sdk",
    baseUrl: "cursor-sdk://local",
    description: "Use Cursor's Composer model from a configured Cursor provider.",
    requiresApiKey: true,
    models: [
      { id: "composer-2", name: "Composer 2" }
    ],
    headers: {}
  },
  {
    id: "custom",
    name: "Custom Provider",
    type: "openai-compatible",
    baseUrl: "",
    description: "Configure any OpenAI-compatible provider, model IDs, and optional headers.",
    requiresApiKey: false,
    custom: true,
    models: [{ id: "model-id", name: "Display Name" }],
    headers: {}
  }
];

function defaultModelParent() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "LocalLeaf");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "LocalLeaf");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "LocalLeaf");
}

function safeStorageRoot(parentPath) {
  const parent = path.resolve(parentPath || defaultModelParent());
  const root = path.basename(parent) === MODEL_FOLDER_NAME ? parent : path.resolve(parent, MODEL_FOLDER_NAME);
  const parentWithSeparator = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  if (root !== parent && !root.startsWith(parentWithSeparator)) {
    throw new Error("Model storage path is invalid.");
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function modelDirectory(storageRoot, modelId) {
  const model = MODEL_CATALOG.find((item) => item.id === modelId);
  if (!model) throw new Error("Unknown LocalLeaf model.");
  return path.join(storageRoot, model.id);
}

function createMemorySecretStore() {
  const secrets = new Map();
  return {
    async getSecret(id) {
      return secrets.get(id) || "";
    },
    async setSecret(id, value) {
      if (value) secrets.set(id, value);
      else secrets.delete(id);
    },
    async deleteSecret(id) {
      secrets.delete(id);
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/u, "");
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Base URL must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Base URL must use http or https.");
  }
  return text;
}

function normalizeProviderId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) throw new Error("Provider ID is required.");
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error("Provider ID can only contain lowercase letters, numbers, hyphens, or underscores.");
  }
  return id;
}

function normalizeModels(models) {
  const items = Array.isArray(models) ? models : [];
  const seen = new Set();
  const normalized = items
    .map((model) => ({
      id: typeof model === "string"
        ? model.trim()
        : String(model?.id || model?.modelId || model?.model || "").trim(),
      name: typeof model === "string"
        ? model.trim()
        : String(model?.name || model?.displayName || model?.id || model?.modelId || model?.model || "").trim()
    }))
    .filter((model) => model.id || model.name)
    .map((model) => {
      if (!model.id) throw new Error("Every model needs a model ID.");
      if (!model.name) throw new Error("Every model needs a display name.");
      if (seen.has(model.id)) throw new Error(`Duplicate model ID: ${model.id}`);
      seen.add(model.id);
      return model;
    });
  if (!normalized.length) throw new Error("Add at least one model.");
  return normalized;
}

function normalizeHeaders(headers) {
  const source = Array.isArray(headers)
    ? Object.fromEntries(headers
        .filter((item) => item?.key || item?.name)
        .map((item) => [item.key || item.name, item.value]))
    : headers || {};
  const output = {};
  const seen = new Set();
  for (const [key, value] of Object.entries(source)) {
    const cleanKey = String(key || "").trim();
    const cleanValue = String(value || "").trim();
    if (!cleanKey && !cleanValue) continue;
    if (!cleanKey || !cleanValue) throw new Error("Header rows need both a name and a value.");
    const lower = cleanKey.toLowerCase();
    if (seen.has(lower)) throw new Error(`Duplicate header: ${cleanKey}`);
    seen.add(lower);
    output[cleanKey] = cleanValue;
  }
  return output;
}

function redactProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    description: provider.description || "",
    models: clone(provider.models || []),
    headers: Object.keys(provider.headers || {}),
    hasApiKey: Boolean(provider.hasApiKey),
    requiresApiKey: Boolean(provider.requiresApiKey),
    custom: Boolean(provider.custom),
    builtin: Boolean(provider.builtin),
    recommended: Boolean(provider.recommended),
    status: provider.status || "not_configured",
    test: provider.test || null,
    updatedAt: provider.updatedAt || null
  };
}

function providerFromTemplate(template, patch = {}) {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    baseUrl: template.baseUrl,
    description: template.description || "",
    models: clone(template.models),
    headers: clone(template.headers || {}),
    requiresApiKey: Boolean(template.requiresApiKey),
    custom: Boolean(template.custom),
    builtin: true,
    recommended: Boolean(template.recommended),
    status: "not_configured",
    hasApiKey: false,
    ...patch
  };
}

function providersFile(storageRoot) {
  return path.join(storageRoot, PROVIDERS_FILE);
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function modelManifestPath(storageRoot, modelId) {
  return path.join(modelDirectory(storageRoot, modelId), "model.json");
}

function modelFilePath(storageRoot, model) {
  return path.join(modelDirectory(storageRoot, model.id), model.filename || `${model.id}.gguf`);
}

function partialModelPath(storageRoot, model) {
  return `${modelFilePath(storageRoot, model)}.part`;
}

function installedModelManifest(storageRoot, modelId) {
  const manifest = safeReadJson(modelManifestPath(storageRoot, modelId), null);
  const model = MODEL_CATALOG.find((item) => item.id === modelId);
  if (!manifest || !model) return null;
  const filePath = modelFilePath(storageRoot, model);
  if (!fs.existsSync(filePath)) return null;
  return { ...manifest, filePath };
}

function notifyAsync(callback) {
  if (typeof callback !== "function") return;
  setTimeout(() => {
    try {
      callback();
    } catch {
      // State broadcasts are best-effort; model work should continue.
    }
  }, 0);
}

function downloadWithNode(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = String(url || "").startsWith("https:") ? https : http;
    const request = client.get(url, {
      headers: {
        "user-agent": "LocalLeaf/1.0",
        ...(options.headers || {})
      },
      signal: options.signal
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(downloadWithNode(new URL(response.headers.location, url).toString(), options));
        return;
      }
      resolve(response);
    });
    request.on("error", reject);
  });
}

function findBundledLlamaServer() {
  const candidates = [
    process.env.LOCALLEAF_LLAMA_SERVER_PATH,
    path.join(ROOT_DIR, "bin", "llama-cpp", LLAMA_SERVER_NAME),
    process.resourcesPath ? path.join(process.resourcesPath, "bin", "llama-cpp", LLAMA_SERVER_NAME) : "",
    path.join(process.cwd(), "bin", "llama-cpp", LLAMA_SERVER_NAME)
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForLlamaServer(baseUrl, fetchImpl, timeoutMs = 60000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchImpl(`${baseUrl}/v1/models`, { method: "GET" });
      if (response.ok) return true;
      lastError = new Error(`llama-server returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(lastError?.message || "Local model runtime did not become ready.");
}

function chatCompletionsUrl(baseUrl) {
  if (/\/chat\/completions$/u.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function responseContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (typeof message?.reasoning_content === "string") return message.reasoning_content;
  if (typeof message?.reasoning === "string") return message.reasoning;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .join("");
  }
  if (typeof payload?.choices?.[0]?.text === "string") return payload.choices[0].text;
  if (typeof payload?.content === "string") return payload.content;
  if (typeof payload?.response === "string") return payload.response;
  return "";
}

function createAiModelManager(options = {}) {
  let storageRoot = safeStorageRoot(options.modelRoot);
  let activeModelId = null;
  let activeProviderId = null;
  const downloads = new Map();
  let localRuntime = null;
  const secretStore = options.secretStore || createMemorySecretStore();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const downloadImpl = options.downloadImpl || null;
  const onChange = options.onChange;
  const providers = new Map();
  if (typeof secretStore.setRoot === "function") secretStore.setRoot(storageRoot);

  function emitChange() {
    notifyAsync(onChange);
  }

  function loadProviders() {
    providers.clear();
    for (const template of PROVIDER_TEMPLATES) {
      providers.set(template.id, providerFromTemplate(template));
    }

    const saved = safeReadJson(providersFile(storageRoot), {});
    activeProviderId = saved.activeProviderId || null;
    activeModelId = saved.activeLocalModelId || activeModelId;
    for (const provider of saved.providers || []) {
      if (!provider?.id) continue;
      providers.set(provider.id, {
        ...providerFromTemplate(PROVIDER_TEMPLATES.find((item) => item.id === provider.id) || {
          id: provider.id,
          name: provider.name || provider.id,
          type: "openai-compatible",
          baseUrl: "",
          models: [],
          headers: {}
        }),
        ...provider,
        hasApiKey: Boolean(provider.hasApiKey)
      });
    }
    if (activeProviderId && !providers.has(activeProviderId)) activeProviderId = null;
  }

  function saveProviders() {
    const savedProviders = [...providers.values()]
      .filter((provider) => provider.hasApiKey || provider.status !== "not_configured" || provider.custom || !provider.builtin)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        description: provider.description || "",
        models: provider.models || [],
        headers: provider.headers || {},
        requiresApiKey: Boolean(provider.requiresApiKey),
        custom: Boolean(provider.custom),
        builtin: Boolean(provider.builtin),
        recommended: Boolean(provider.recommended),
        hasApiKey: Boolean(provider.hasApiKey),
        status: provider.status || "not_configured",
        test: provider.test || null,
        updatedAt: provider.updatedAt || null
      }));
    writeJson(providersFile(storageRoot), {
      version: 1,
      activeProviderId,
      activeLocalModelId: activeModelId,
      providers: savedProviders
    });
  }

  loadProviders();

  function installedModelIds() {
    return new Set(MODEL_CATALOG
      .filter((model) => installedModelManifest(storageRoot, model.id))
      .map((model) => model.id));
  }

  function allModelChoices() {
    const installed = installedModelIds();
    const local = MODEL_CATALOG.filter((model) => installed.has(model.id)).map((model) => ({
      providerId: "localleaf-local",
      providerName: "LocalLeaf Local",
      modelId: model.id,
      name: model.name,
      local: true
    }));
    const remote = [...providers.values()].flatMap((provider) => (provider.models || []).map((model) => ({
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      name: model.name,
      local: false,
      hasApiKey: provider.hasApiKey,
      status: provider.status || "not_configured"
    })));
    return [...local, ...remote];
  }

  function activeProvider() {
    return activeProviderId ? providers.get(activeProviderId) || null : null;
  }

  function activeModelChoice() {
    const provider = activeProvider();
    if (provider) {
      const model = (provider.models || []).find((item) => item.id === activeModelId) || provider.models?.[0] || null;
      return model ? {
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name,
        local: false
      } : null;
    }
    const model = MODEL_CATALOG.find((item) => item.id === activeModelId);
    return model ? {
      providerId: "localleaf-local",
      providerName: "LocalLeaf Local",
      modelId: model.id,
      name: model.name,
      local: true
    } : null;
  }

  function publicState() {
    const installed = installedModelIds();
    const configuredProviders = [...providers.values()].filter((provider) => {
      return provider.hasApiKey
        || provider.status !== "not_configured"
        || provider.custom
        || !provider.builtin
        || activeProviderId === provider.id;
    });
    return {
      storagePath: storageRoot,
      storagePathLabel: storageRoot,
      activeModelId,
      activeProviderId,
      activeModel: activeModelChoice(),
      runtime: activeProviderId
        ? (providers.get(activeProviderId)?.type || "openai-compatible")
        : activeModelId && installed.has(activeModelId)
          ? "local-llama-cpp"
          : "deterministic-fallback",
      permissions: {
        canReadTextFiles: true,
        canProposeTextEdits: true,
        canWriteWithoutApproval: false,
        canDeleteRenameMoveUploadShell: false,
        textFilesOnly: true
      },
      models: MODEL_CATALOG.map((model) => {
        const progress = downloads.get(model.id) || null;
        const isInstalled = installed.has(model.id);
        return {
          ...model,
          installed: isInstalled,
          status: progress?.status || (isInstalled ? "installed" : "not_downloaded"),
          progress: progress?.progress || (isInstalled ? 100 : 0),
          bytesReceived: progress?.bytesReceived || (isInstalled ? (installedModelManifest(storageRoot, model.id)?.bytes || model.expectedBytes || 0) : 0),
          totalBytes: progress?.totalBytes || model.expectedBytes || 0,
          error: progress?.error || null
        };
      }),
      providerTemplates: PROVIDER_TEMPLATES.map((template) => redactProvider(providerFromTemplate(template))),
      providers: configuredProviders.map(redactProvider),
      modelChoices: allModelChoices()
    };
  }

  function setStoragePath(parentPath) {
    stopLocalRuntime();
    storageRoot = safeStorageRoot(parentPath);
    if (typeof secretStore.setRoot === "function") secretStore.setRoot(storageRoot);
    const installed = installedModelIds();
    if (activeModelId && !installed.has(activeModelId) && !activeProviderId) activeModelId = null;
    loadProviders();
    return publicState();
  }

  function setDownloadState(modelId, patch) {
    const previous = downloads.get(modelId) || {};
    downloads.set(modelId, { ...previous, ...patch });
    emitChange();
  }

  function activeInstalledModel() {
    const installed = installedModelIds();
    const model = MODEL_CATALOG.find((item) => item.id === activeModelId && installed.has(item.id))
      || MODEL_CATALOG.find((item) => installed.has(item.id));
    if (model && (!activeModelId || !installed.has(activeModelId))) {
      activeModelId = model.id;
      activeProviderId = null;
      saveProviders();
    }
    return model || null;
  }

  async function defaultDownloadModel(model, controller, onProgress) {
    const target = modelFilePath(storageRoot, model);
    const partial = partialModelPath(storageRoot, model);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let existingBytes = 0;
    try {
      existingBytes = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    } catch {
      existingBytes = 0;
    }
    const headers = existingBytes > 0 ? { range: `bytes=${existingBytes}-` } : {};
    const response = await downloadWithNode(model.downloadUrl, { headers, signal: controller.signal });
    if (response.statusCode === 200 && existingBytes > 0) {
      fs.rmSync(partial, { force: true });
      existingBytes = 0;
    }
    if (![200, 206].includes(response.statusCode)) {
      response.resume();
      throw new Error(`Model download failed with HTTP ${response.statusCode}.`);
    }
    const totalHeader = Number(response.headers["content-length"] || 0);
    const totalBytes = response.statusCode === 206
      ? existingBytes + totalHeader
      : totalHeader || model.expectedBytes || 0;
    let bytesReceived = existingBytes;
    onProgress({
      bytesReceived,
      totalBytes,
      progress: totalBytes ? Math.min(99, Math.round((bytesReceived / totalBytes) * 100)) : 1
    });
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(partial, { flags: existingBytes ? "a" : "w" });
      response.on("data", (chunk) => {
        bytesReceived += chunk.length;
        onProgress({
          bytesReceived,
          totalBytes,
          progress: totalBytes ? Math.min(99, Math.round((bytesReceived / totalBytes) * 100)) : 1
        });
      });
      response.on("error", reject);
      file.on("error", reject);
      file.on("finish", resolve);
      response.pipe(file);
    });
    fs.renameSync(partial, target);
    return { bytes: bytesReceived, filePath: target };
  }

  async function finishDownload(model, result = {}) {
    const target = modelFilePath(storageRoot, model);
    const bytes = Number(result.bytes || (fs.existsSync(target) ? fs.statSync(target).size : 0) || model.expectedBytes || 0);
    writeJson(modelManifestPath(storageRoot, model.id), {
      id: model.id,
      name: model.name,
      filename: model.filename,
      bytes,
      source: model.downloadUrl,
      installedAt: new Date().toISOString()
    });
    downloads.set(model.id, { status: "installed", progress: 100, bytesReceived: bytes, totalBytes: bytes, error: null });
    activeModelId = model.id;
    activeProviderId = null;
    saveProviders();
    emitChange();
  }

  function startDownload(modelId) {
    const model = MODEL_CATALOG.find((item) => item.id === modelId);
    if (!model) throw new Error("Unknown LocalLeaf model.");
    const existing = downloads.get(modelId);
    if (existing?.status === "downloading") return publicState();
    if (installedModelManifest(storageRoot, modelId)) {
      if (!activeProviderId) activeModelId = modelId;
      saveProviders();
      return publicState();
    }
    const controller = new AbortController();
    downloads.set(modelId, {
      status: "downloading",
      progress: Math.max(1, existing?.progress || 1),
      bytesReceived: existing?.bytesReceived || 0,
      totalBytes: existing?.totalBytes || model.expectedBytes || 0,
      error: null,
      controller
    });
    emitChange();
    Promise.resolve()
      .then(async () => {
        const onProgress = (progress) => {
          const current = downloads.get(modelId);
          if (!current || current.controller !== controller || current.status !== "downloading") return;
          downloads.set(modelId, { ...current, ...progress, error: null });
          emitChange();
        };
        const result = downloadImpl
          ? await downloadImpl({ model, storageRoot, targetPath: modelFilePath(storageRoot, model), partialPath: partialModelPath(storageRoot, model), signal: controller.signal, onProgress })
          : await defaultDownloadModel(model, controller, onProgress);
        if (controller.signal.aborted) return;
        await finishDownload(model, result);
      })
      .catch((error) => {
        const current = downloads.get(modelId);
        if (!current || current.controller !== controller) return;
        if (controller.signal.aborted && current.status === "paused") {
          emitChange();
          return;
        }
        downloads.set(modelId, {
          status: "failed",
          progress: current.progress || 0,
          bytesReceived: current.bytesReceived || 0,
          totalBytes: current.totalBytes || model.expectedBytes || 0,
          error: error.message || "Model download failed."
        });
        emitChange();
      });
    return publicState();
  }

  function pauseDownload(modelId) {
    const current = downloads.get(modelId);
    if (!current || current.status !== "downloading") return publicState();
    downloads.set(modelId, { ...current, status: "paused", error: null });
    current.controller?.abort?.();
    emitChange();
    return publicState();
  }

  function cancelDownload(modelId) {
    const model = MODEL_CATALOG.find((item) => item.id === modelId);
    const current = downloads.get(modelId);
    current?.controller?.abort?.();
    if (model) fs.rmSync(partialModelPath(storageRoot, model), { force: true });
    downloads.set(modelId, { status: "not_downloaded", progress: 0, bytesReceived: 0, totalBytes: model?.expectedBytes || 0, error: null });
    emitChange();
    return publicState();
  }

  function deleteModel(modelId) {
    const current = downloads.get(modelId);
    current?.controller?.abort?.();
    const target = modelDirectory(storageRoot, modelId);
    fs.rmSync(target, { recursive: true, force: true });
    downloads.set(modelId, { status: "not_downloaded", progress: 0, error: null });
    if (localRuntime?.modelId === modelId) stopLocalRuntime();
    if (activeModelId === modelId && !activeProviderId) activeModelId = activeInstalledModel()?.id || null;
    saveProviders();
    emitChange();
    return publicState();
  }

  function activateModel(modelId) {
    const installed = installedModelIds();
    if (!installed.has(modelId)) {
      throw new Error("Download the model before activating it.");
    }
    activeModelId = modelId;
    activeProviderId = null;
    saveProviders();
    return publicState();
  }

  function buildProvider(input = {}) {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === input.templateId || item.id === input.id);
    const id = normalizeProviderId(input.id || input.providerId || template?.id);
    const name = String(input.name || input.displayName || template?.name || "").trim();
    if (!name) throw new Error("Display name is required.");
    const type = input.type || template?.type || "openai-compatible";
    const baseUrl = type === "cursor-sdk"
      ? String(input.baseUrl ?? input.baseURL ?? template?.baseUrl ?? "cursor-sdk://local").trim()
      : normalizeUrl(input.baseUrl ?? input.baseURL ?? template?.baseUrl);
    if (!baseUrl) throw new Error(type === "cursor-sdk" ? "Cursor provider URL is required." : "Base URL is required.");
    const models = normalizeModels(input.models || template?.models || []);
    const headers = normalizeHeaders(input.headers || template?.headers || {});
    return {
      id,
      name,
      type,
      baseUrl,
      description: input.description || template?.description || "",
      models,
      headers,
      requiresApiKey: input.requiresApiKey ?? template?.requiresApiKey ?? false,
      custom: Boolean(input.custom ?? template?.custom ?? !template),
      builtin: Boolean(template && id === template.id),
      recommended: Boolean(template?.recommended),
      hasApiKey: Boolean(input.apiKey || input.hasApiKey || providers.get(id)?.hasApiKey),
      status: providers.get(id)?.status || "not_configured",
      test: providers.get(id)?.test || null,
      updatedAt: Date.now()
    };
  }

  async function saveProvider(input = {}) {
    const provider = buildProvider(input);
    const providedKey = String(input.apiKey || "").trim();
    if (Object.prototype.hasOwnProperty.call(input, "apiKey") && providedKey) {
      await secretStore.setSecret(provider.id, providedKey);
      provider.hasApiKey = true;
    } else {
      provider.hasApiKey = Boolean(providers.get(provider.id)?.hasApiKey || provider.hasApiKey);
    }
    if (provider.hasApiKey || !provider.requiresApiKey) provider.status = provider.status === "ready" ? "ready" : "configured";
    providers.set(provider.id, provider);
    if (input.activate || !activeProviderId) {
      activeProviderId = provider.id;
      activeModelId = input.modelId || provider.models[0]?.id || null;
    }
    saveProviders();
    return publicState();
  }

  async function deleteProvider(providerId) {
    const id = normalizeProviderId(providerId);
    const provider = providers.get(id);
    if (!provider) throw new Error("Provider was not found.");
    const template = PROVIDER_TEMPLATES.find((item) => item.id === id);
    await secretStore.deleteSecret(id);
    if (template) providers.set(id, providerFromTemplate(template));
    else providers.delete(id);
    if (activeProviderId === id) {
      activeProviderId = null;
      activeModelId = null;
    }
    saveProviders();
    return publicState();
  }

  function activateProvider(providerId, modelId) {
    const id = normalizeProviderId(providerId);
    const provider = providers.get(id);
    if (!provider) throw new Error("Provider was not found.");
    if (provider.requiresApiKey && !provider.hasApiKey) throw new Error("Add an API key before using this provider.");
    const nextModel = String(modelId || provider.models?.[0]?.id || "").trim();
    if (!nextModel || !(provider.models || []).some((model) => model.id === nextModel)) {
      throw new Error("Choose a configured model for this provider.");
    }
    activeProviderId = id;
    activeModelId = nextModel;
    saveProviders();
    return publicState();
  }

  async function resolveProviderForUse(input = {}) {
    const temporary = input.provider || input.baseUrl || input.baseURL;
    const provider = temporary ? buildProvider(input.provider || input) : providers.get(normalizeProviderId(input.providerId || activeProviderId));
    if (!provider) throw new Error("Provider was not found.");
    if (provider.type && provider.type !== "openai-compatible") {
      throw new Error(`${provider.name} is not an OpenAI-compatible provider.`);
    }
    const inputKey = String(input.apiKey || "").trim();
    const apiKey = inputKey || await secretStore.getSecret(provider.id);
    const modelId = String(input.modelId || activeModelId || provider.models?.[0]?.id || "").trim();
    if (!modelId) throw new Error("Choose a model before testing this provider.");
    if (provider.requiresApiKey && !apiKey) throw new Error("API key is required for this provider.");
    return { provider, apiKey, modelId };
  }

  async function sendOpenAiCompatible(input = {}) {
    if (typeof fetchImpl !== "function") throw new Error("This runtime cannot make provider requests.");
    const { provider, apiKey, modelId } = await resolveProviderForUse(input);
    const timeoutMs = Number(input.timeoutMs || DEFAULT_TEST_TIMEOUT_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      "content-type": "application/json",
      ...provider.headers
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    try {
      const response = await fetchImpl(chatCompletionsUrl(provider.baseUrl), {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: modelId,
          messages: input.messages || [
            { role: "user", content: "Reply with LOCALLEAF_OK only." }
          ],
          max_tokens: Number(input.maxTokens || 32),
          temperature: Number(input.temperature ?? 0)
        })
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("Provider returned a malformed JSON response.");
      }
      if (!response.ok) {
        const requestError = new Error(payload?.error?.message || `Provider request failed with HTTP ${response.status}.`);
        requestError.statusCode = response.status;
        throw requestError;
      }
      const content = responseContent(payload).trim();
      if (!content) {
        const emptyError = new Error("Provider returned a malformed response.");
        emptyError.statusCode = 502;
        throw emptyError;
      }
      return { provider, modelId, content, raw: payload };
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`Provider request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function testProvider(input = {}) {
    const startedAt = Date.now();
    let providerId = input.providerId || input.provider?.id || input.id || activeProviderId || "";
    let modelId = input.modelId || activeModelId || "";
    try {
      const lookupProviderId = providerId || activeProviderId || "";
      const providerForTest = input.provider
        ? buildProvider(input.provider)
        : lookupProviderId
          ? providers.get(normalizeProviderId(lookupProviderId))
          : null;
      if (providerForTest?.type === "cursor-sdk") {
        const apiKey = String(input.apiKey || await secretStore.getSecret(providerForTest.id) || "").trim();
        if (providerForTest.requiresApiKey && !apiKey) throw new Error("API key is required for Cursor.");
        const test = {
          ok: true,
          status: "ready",
          color: "green",
          message: "Cursor provider saved.",
          providerId: providerForTest.id,
          modelId: modelId || providerForTest.models?.[0]?.id || "composer-2",
          responseMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString()
        };
        const provider = providers.get(providerForTest.id);
        if (provider && !input.provider && !input.baseUrl && !input.baseURL) {
          provider.status = "ready";
          provider.test = test;
          saveProviders();
        }
        return test;
      }
      const result = await sendOpenAiCompatible({ ...input, maxTokens: input.maxTokens || 128 });
      providerId = result.provider.id;
      modelId = result.modelId;
      const test = {
        ok: true,
        status: "ready",
        color: "green",
        message: result.content.includes("LOCALLEAF_OK") ? "Connection ready." : "Provider responded.",
        providerId,
        modelId,
        responseMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
      const provider = providers.get(providerId);
      if (provider && !input.provider && !input.baseUrl && !input.baseURL) {
        provider.status = "ready";
        provider.test = test;
        saveProviders();
      }
      return test;
    } catch (error) {
      const test = {
        ok: false,
        status: "failed",
        color: "red",
        message: error.message || "Provider test failed.",
        providerId,
        modelId,
        responseMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
      const provider = providers.get(providerId);
      if (provider && !input.provider && !input.baseUrl && !input.baseURL) {
        provider.status = "failed";
        provider.test = test;
        saveProviders();
      }
      return test;
    }
  }

  async function validateProvider(input = {}) {
    const payload = input.provider ? { ...input.provider, modelId: input.modelId || input.provider.model || input.provider.modelId } : input;
    const provider = buildProvider(payload);
    const modelId = String(payload.modelId || payload.model || provider.models[0]?.id || "").trim();
    if (provider.type === "cursor-sdk") {
      provider.hasApiKey = Boolean(payload.apiKey || await secretStore.getSecret(provider.id));
      if (provider.requiresApiKey && !provider.hasApiKey) throw new Error("API key is required for Cursor.");
      provider.status = "configured";
      providers.set(provider.id, provider);
      if (Object.prototype.hasOwnProperty.call(payload, "apiKey") && String(payload.apiKey || "").trim()) {
        await secretStore.setSecret(provider.id, String(payload.apiKey || "").trim());
      }
      saveProviders();
      return { ok: true, provider: redactProvider(provider), test: { ok: true, status: "ready", color: "green", message: "Cursor provider saved.", providerId: provider.id, modelId } };
    }
    const result = await sendOpenAiCompatible({
      provider,
      apiKey: payload.apiKey,
      modelId,
      maxTokens: payload.maxTokens || 128,
      timeoutMs: payload.timeoutMs
    });
    provider.hasApiKey = Boolean(payload.apiKey || provider.hasApiKey);
    provider.status = "configured";
    provider.test = {
      ok: true,
      status: "ready",
      color: "green",
      message: result.content.includes("LOCALLEAF_OK") ? "Connection ready." : "Provider responded.",
      providerId: provider.id,
      modelId,
      responseMs: 0,
      checkedAt: new Date().toISOString()
    };
    providers.set(provider.id, provider);
    if (Object.prototype.hasOwnProperty.call(payload, "apiKey") && String(payload.apiKey || "").trim()) {
      await secretStore.setSecret(provider.id, String(payload.apiKey || "").trim());
    }
    saveProviders();
    return { ok: true, provider: redactProvider(provider), test: provider.test };
  }

  function stopLocalRuntime() {
    if (!localRuntime) return;
    try {
      localRuntime.process?.kill?.();
    } catch {
      // Runtime cleanup is best-effort.
    }
    localRuntime = null;
  }

  async function ensureLocalRuntime(modelId) {
    if (typeof fetchImpl !== "function") throw new Error("This runtime cannot run local model requests.");
    const model = modelId
      ? MODEL_CATALOG.find((item) => item.id === modelId)
      : activeInstalledModel();
    if (!model || !installedModelManifest(storageRoot, model.id)) {
      throw new Error("Download a LocalLeaf model before using local AI.");
    }
    if (localRuntime?.modelId === model.id && localRuntime.baseUrl && localRuntime.process && !localRuntime.process.killed) {
      return { model, baseUrl: localRuntime.baseUrl };
    }
    stopLocalRuntime();
    const serverPath = findBundledLlamaServer();
    if (!serverPath) {
      throw new Error("Local model runtime is missing from this build. Reinstall LocalLeaf or use a hosted provider.");
    }
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const modelPath = modelFilePath(storageRoot, model);
    const child = spawn(serverPath, [
      "-m", modelPath,
      "--host", "127.0.0.1",
      "--port", String(port),
      "-c", "4096",
      "--jinja",
      "--no-webui",
      "--log-disable"
    ], {
      cwd: path.dirname(serverPath),
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    localRuntime = { modelId: model.id, baseUrl, process: child };
    child.once("exit", () => {
      if (localRuntime?.process === child) localRuntime = null;
    });
    await waitForLlamaServer(baseUrl, fetchImpl);
    return { model, baseUrl };
  }

  async function askLocalModel(messages, options = {}) {
    const requestedModel = String(options.modelId || activeModelId || "").trim();
    const { model, baseUrl } = await ensureLocalRuntime(requestedModel);
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.filename || model.id,
        messages,
        temperature: Number(options.temperature ?? 0.1),
        max_tokens: Number(options.maxTokens || 1200),
        stream: false
      })
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Local model returned a malformed JSON response.");
    }
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Local model request failed with HTTP ${response.status}.`);
    }
    const content = responseContent(payload).trim();
    if (!content) throw new Error("Local model returned an empty response.");
    return {
      provider: {
        id: "localleaf-local",
        name: "LocalLeaf Local",
        type: "local-llama-cpp"
      },
      modelId: model.id,
      content,
      raw: payload
    };
  }

  async function cursorProviderConfig(input = {}) {
    const id = normalizeProviderId(input.providerId || activeProviderId || "cursor");
    const provider = providers.get(id);
    if (!provider || provider.type !== "cursor-sdk") throw new Error("Connect Cursor in Settings before using Composer.");
    const apiKey = String(input.apiKey || await secretStore.getSecret(provider.id) || "").trim();
    if (provider.requiresApiKey && !apiKey) throw new Error("Add a Cursor API key before using Composer.");
    const modelId = String(input.modelId || activeModelId || provider.models?.[0]?.id || "composer-2").trim();
    return { provider, apiKey, modelId };
  }

  function hasActiveLocalModel() {
    return Boolean(activeInstalledModel());
  }

  async function askActiveProvider(messages, options = {}) {
    const providerId = options.providerId || activeProviderId;
    if (!providerId) return null;
    return sendOpenAiCompatible({
      providerId,
      modelId: options.modelId || (providerId === activeProviderId ? activeModelId : ""),
      messages,
      maxTokens: options.maxTokens || 800,
      temperature: options.temperature ?? 0.2,
      timeoutMs: options.timeoutMs || DEFAULT_GENERATION_TIMEOUT_MS
    });
  }

  async function runSmokeTest(input = {}) {
    const apiKey = String(input.apiKey || "");
    if (!apiKey) throw new Error("API key is required for smoke testing.");
    const smokeProvider = {
      id: "opencode-go-smoke",
      name: "OpenCode Go Smoke",
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/zen/go/v1",
      requiresApiKey: true,
      models: [
        { id: "kimi-k2.6", name: "Kimi K2.6" },
        { id: "glm-5.1", name: "GLM 5.1" }
      ],
      headers: {}
    };
    const results = [];
    try {
      for (const model of smokeProvider.models) {
        results.push(await testProvider({
          provider: smokeProvider,
          apiKey,
          modelId: model.id,
          timeoutMs: input.timeoutMs || DEFAULT_TEST_TIMEOUT_MS
        }));
      }
      return {
        ok: results.every((item) => item.ok),
        results
      };
    } finally {
      await secretStore.deleteSecret(smokeProvider.id);
    }
  }

  return {
    catalog: MODEL_CATALOG,
    providerTemplates: PROVIDER_TEMPLATES,
    publicState,
    setStoragePath,
    simulateDownload: startDownload,
    downloadModel: startDownload,
    pauseDownload,
    cancelDownload,
    deleteModel,
    activateModel,
    saveProvider,
    deleteProvider,
    activateProvider,
    testProvider,
    validateProvider,
    hasActiveLocalModel,
    askLocalModel,
    askActiveProvider,
    cursorProviderConfig,
    stopLocalRuntime,
    runSmokeTest
  };
}

module.exports = {
  MODEL_CATALOG,
  MODEL_FOLDER_NAME,
  PROVIDER_TEMPLATES,
  PROVIDER_ID_PATTERN,
  createAiModelManager
};
