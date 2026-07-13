const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createTestLocalLeafServer: createLocalLeafServer } = require("./helpers/localleaf-test-server");

function hostBaseUrl(app, port) {
  return `http://localhost:${port}/?host=${encodeURIComponent(app.state.hostToken)}`;
}

function buildTestUrl(baseUrl, requestPath) {
  const base = new URL(baseUrl);
  return new URL(requestPath, base.origin).toString();
}

function hostHeaders(baseUrl, headers = {}) {
  const hostToken = new URL(baseUrl).searchParams.get("host");
  return {
    ...headers,
    ...(hostToken ? { "x-localleaf-host-token": hostToken } : {})
  };
}

async function rawRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, requestPath), {
    method: options.method || "GET",
    headers: hostHeaders(baseUrl, { "content-type": "application/json", ...(options.headers || {}) }),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : {} };
}

async function request(baseUrl, requestPath, options = {}) {
  const result = await rawRequest(baseUrl, requestPath, options);
  if (!result.response.ok) {
    throw new Error(result.payload.error || result.response.statusText);
  }
  return result.payload;
}

async function startApp(projectRoot, options = {}) {
  const app = createLocalLeafServer({
    port: 0,
    projectRoot,
    modelRoot: path.join(projectRoot, ".localleaf-models"),
    autoStartTunnel: false,
    ...options
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  return { app, baseUrl: hostBaseUrl(app, port) };
}

async function startOpenAiCompatibleMock(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    await once(req, "end");
    const body = rawBody ? JSON.parse(rawBody) : {};
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    const result = await handler({ req, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { server, baseUrl, calls };
}

function createProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-provider-project-"));
  fs.writeFileSync(
    path.join(projectRoot, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n"
  );
  return projectRoot;
}

test("reports an automatic local context plan and clamps the advanced override", async () => {
  const projectRoot = createProject();
  const previous = process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE;
  const { app, baseUrl } = await startApp(projectRoot, {
    aiTotalMemoryBytes: 16 * 1024 ** 3
  });

  try {
    for (const [configured, expected] of [["1024", 4096], ["24576", 24576], ["999999", 32768], ["invalid", 16384]]) {
      process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE = configured;
      const state = await request(baseUrl, "/api/state");
      const model = state.ai.models[0];
      assert.equal(model.contextWindowTokens, expected);
      assert.equal(model.contextWindow.effectiveTokens, expected);
      assert.equal(model.contextWindow.modelMaximumTokens, 32768);
      assert.equal(model.contextWindow.mode, configured === "invalid" ? "automatic" : "advanced_override");
      assert.equal(model.contextWindow.source, configured === "invalid" ? "host_memory" : "environment");
    }
  } finally {
    if (previous === undefined) delete process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE;
    else process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE = previous;
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("scales automatic local context to stable host-memory tiers without exceeding model metadata", async () => {
  const previous = process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE;
  delete process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE;
  const cases = [
    { memoryGiB: 4, expectedTokens: 4096, profile: "constrained" },
    { memoryGiB: 8, expectedTokens: 8192, profile: "compact" },
    { memoryGiB: 16, expectedTokens: 16384, profile: "balanced" },
    { memoryGiB: 32, expectedTokens: 32768, profile: "expanded" }
  ];

  try {
    for (const item of cases) {
      const projectRoot = createProject();
      const { app, baseUrl } = await startApp(projectRoot, {
        aiTotalMemoryBytes: item.memoryGiB * 1024 ** 3
      });
      try {
        const state = await request(baseUrl, "/api/state");
        const model = state.ai.models[0];
        assert.equal(model.contextWindowTokens, item.expectedTokens);
        assert.deepEqual(model.contextWindow, {
          mode: "automatic",
          source: "host_memory",
          resourceProfile: item.profile,
          effectiveTokens: item.expectedTokens,
          modelMaximumTokens: 32768
        });
      } finally {
        await app.stop();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE;
    else process.env.LOCALLEAF_LOCAL_CONTEXT_SIZE = previous;
  }
});

test("validates OpenAI-compatible providers and redacts provider state", async () => {
  const projectRoot = createProject();
  const mock = await startOpenAiCompatibleMock(({ body, req }) => {
    assert.equal(req.headers.authorization, "Bearer test-provider-key");
    assert.equal(body.model, "kimi-k2.6");
    return {
      status: 200,
      body: {
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "Provider ready." } }]
      }
    };
  });
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const validated = await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "moonshot",
          name: "Moonshot",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          apiKey: "test-provider-key",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    assert.equal(validated.ok, true);
    assert.equal(validated.provider.id, "moonshot");
    assert.equal(validated.provider.status, "configured");
    assert.equal(validated.provider.apiKey, undefined);
    assert.equal(JSON.stringify(validated), JSON.stringify(validated).replace("test-provider-key", ""));

    const state = await request(baseUrl, "/api/state");
    const serializedState = JSON.stringify(state.ai);
    assert.match(serializedState, /moonshot/);
    assert.doesNotMatch(serializedState, /test-provider-key/);
    assert.equal(state.ai.providers.find((provider) => provider.id === "moonshot").hasApiKey, true);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, "/v1/chat/completions");
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("surfaces OpenAI-compatible 401 and malformed validation responses", async () => {
  const projectRoot = createProject();
  const unauthorizedMock = await startOpenAiCompatibleMock(() => ({
    status: 401,
    body: { error: { message: "bad key" } }
  }));
  const malformedMock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: { choices: [] }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const unauthorized = await rawRequest(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "bad-key",
          name: "Bad Key",
          type: "openai-compatible",
          baseUrl: unauthorizedMock.baseUrl,
          apiKey: "never-real",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    assert.equal(unauthorized.response.status, 401);
    assert.match(unauthorized.payload.error, /bad key|unauthorized|401/i);

    const malformed = await rawRequest(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "malformed",
          name: "Malformed",
          type: "openai-compatible",
          baseUrl: malformedMock.baseUrl,
          apiKey: "never-real",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    assert.equal(malformed.response.status, 502);
    assert.match(malformed.payload.error, /malformed|unreadable|invalid/i);
  } finally {
    await app.stop();
    await new Promise((resolve) => unauthorizedMock.server.close(resolve));
    await new Promise((resolve) => malformedMock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("adds the OpenCode Go preset and supports provider activation and deletion", async () => {
  const projectRoot = createProject();
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const preset = await request(baseUrl, "/api/ai/providers/presets/opencode-go", {
      method: "POST",
      body: { apiKey: "local-test-key" }
    });
    const opencode = preset.providers.find((provider) => provider.id === "opencode-go");
    assert.equal(opencode.name, "OpenCode Go");
    assert.equal(opencode.apiKey, undefined);
    assert.equal(opencode.hasApiKey, true);
    assert.deepEqual(opencode.models.map((model) => model.id || model), ["kimi-k2.6", "glm-5.1"]);

    const activated = await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "opencode-go", modelId: "glm-5.1" }
    });
    assert.equal(activated.activeProviderId, "opencode-go");
    assert.equal(activated.activeModelId, "glm-5.1");

    const deleted = await request(baseUrl, "/api/ai/providers/delete", {
      method: "POST",
      body: { providerId: "opencode-go" }
    });
    assert.equal(deleted.activeProviderId, null);
    assert.equal(deleted.providers.some((provider) => provider.id === "opencode-go"), false);
    assert.doesNotMatch(JSON.stringify(deleted), /local-test-key/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("keeps user-defined providers custom when their ID or name matches a built-in", async () => {
  const projectRoot = createProject();
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const idCollision = await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "openai",
        name: "Private gateway",
        baseUrl: "https://gateway.example/v1",
        models: [{ id: "private-model", name: "Private model" }],
        custom: false,
        builtin: true
      }
    });
    const customOpenAiId = idCollision.providers.find((provider) => provider.id === "openai");
    assert.equal(customOpenAiId.name, "Private gateway");
    assert.equal(customOpenAiId.custom, true);
    assert.equal(customOpenAiId.builtin, false);

    const nameCollision = await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "private-openrouter",
        name: "OpenRouter",
        baseUrl: "https://router.example/v1",
        models: [{ id: "private-model", name: "Private model" }],
        custom: false,
        builtin: true
      }
    });
    const customOpenRouterName = nameCollision.providers.find((provider) => provider.id === "private-openrouter");
    assert.equal(customOpenRouterName.name, "OpenRouter");
    assert.equal(customOpenRouterName.custom, true);
    assert.equal(customOpenRouterName.builtin, false);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("requires an exact known template selection before assigning built-in branding", async () => {
  const projectRoot = createProject();
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const unknownTemplate = await rawRequest(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        templateId: "not-a-provider",
        id: "not-a-provider",
        name: "Unknown template",
        baseUrl: "https://provider.example/v1",
        models: [{ id: "model", name: "Model" }]
      }
    });
    assert.equal(unknownTemplate.response.status, 400);
    assert.match(unknownTemplate.payload.error, /unknown provider preset/i);

    const mismatchedTemplate = await rawRequest(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        templateId: "openai",
        id: "openrouter",
        name: "Mismatched preset",
        baseUrl: "https://provider.example/v1",
        models: [{ id: "model", name: "Model" }]
      }
    });
    assert.equal(mismatchedTemplate.response.status, 400);
    assert.match(mismatchedTemplate.payload.error, /provider ID.*preset/i);

    const builtIn = await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: { templateId: "ollama", id: "ollama", activate: false }
    });
    const ollama = builtIn.providers.find((provider) => provider.id === "ollama");
    assert.equal(ollama.custom, false);
    assert.equal(ollama.builtin, true);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("uses hosted provider replacement instructions to create safe LaTeX edit proposals", async () => {
  const projectRoot = createProject();
  const mainPath = path.join(projectRoot, "main.tex");
  let agentPrompt = "";
  const mock = await startOpenAiCompatibleMock(({ body }) => {
    assert.equal(body.model, "kimi-k2.6");
    const prompt = body.messages?.map((item) => String(item.content || "")).join("\n\n") || "";
    if (/Return JSON only with this shape/u.test(prompt)) agentPrompt = prompt;
    return {
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "## Edit summary\n\nI found the exact sentence and kept the rest of the document unchanged.",
              summary: "Replace the verbose sentence.",
              replacements: [{
                find: "We utilize this draft.",
                replace: "We use this draft."
              }]
            })
          }
        }]
      }
    };
  });
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "hosted",
          name: "Hosted",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          apiKey: "test-provider-key",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "hosted", modelId: "kimi-k2.6" }
    });

    const localOnly = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "change from We utilize this draft. to We use this draft.",
        aiProviderId: "hosted",
        aiModelId: "kimi-k2.6",
        aiPermissions: { localModelOnly: true }
      }
    });
    assert.equal(localOnly.response.status, 400);
    assert.match(localOnly.payload.error, /Local model only/i);

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "change from We utilize this draft. to We use this draft." }
    });
    assert.equal(message.provider.id, "hosted");
    assert.equal(message.proposals.length, 1);
    assert.equal(message.proposals[0].provider.id, "hosted");
    assert.match(message.proposals[0].newText, /We use this draft/);
    assert.match(
      message.reply,
      /^I prepared an edit to `main\.tex` for review, replacing "We utilize this draft\." with "We use this draft\."/u
    );
    assert.doesNotMatch(message.reply.split("\n")[0], /[.!?]["']\./u);
    assert.match(message.reply, /## Edit summary/u);
    assert.match(agentPrompt, /LocalLeaf safe Markdown/u);
    assert.match(agentPrompt, /never add commentary outside the JSON object/u);
    assert.match(agentPrompt, /preserve the requested voice, facts, quotations, citations, and meaning/u);
    assert.doesNotMatch(fs.readFileSync(mainPath, "utf8"), /We use this draft/);

    await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: message.proposals[0].id }
    });
    assert.match(fs.readFileSync(mainPath, "utf8"), /We use this draft/);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("normalizes hosted proposal summaries before returning approval cards", async () => {
  const projectRoot = createProject();
  const unsafeSummary = `## **Update** <img src=x onerror=alert(1)> [unsafe](javascript:alert(1)) [reference](https://example.com) ${"detail ".repeat(40)}`;
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: {
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({
            reply: "The sentence is ready for review.",
            summary: unsafeSummary,
            replacements: [{
              find: "We utilize this draft.",
              replace: "We use this draft."
            }]
          })
        }
      }]
    }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "summary-provider",
        name: "Summary Provider",
        type: "openai-compatible",
        baseUrl: mock.baseUrl,
        apiKey: "test-provider-key",
        modelId: "summary-model",
        models: [{ id: "summary-model", name: "Summary Model" }],
        activate: true
      }
    });

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this sentence" }
    });

    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].summary, /^Update unsafe reference detail/u);
    assert.ok(message.proposals[0].summary.length <= 180);
    assert.doesNotMatch(message.proposals[0].summary, /[#*<>\[\]]|javascript:|https?:\/\//iu);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("preserves validated hosted context windows and rejects unsafe limits", async () => {
  const projectRoot = createProject();
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: {
      choices: [{ message: { role: "assistant", content: "Provider ready." } }]
    }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const validated = await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "context-provider",
          name: "Context Provider",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [{ id: "context-model", name: "Context Model", contextWindowTokens: 131072 }]
        }
      }
    });
    assert.equal(validated.provider.models[0].contextWindowTokens, 131072);

    const callsBeforeInvalidRequest = mock.calls.length;
    const invalid = await rawRequest(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "bad-context-provider",
          name: "Bad Context Provider",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [{ id: "context-model", name: "Context Model", contextWindowTokens: 1000 }]
        }
      }
    });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.payload.error, /context window/i);
    assert.equal(mock.calls.length, callsBeforeInvalidRequest);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects unconfigured provider model IDs before a generation request", async () => {
  const projectRoot = createProject();
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: {
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ reply: "No edit needed.", edits: [] })
        }
      }]
    }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "configured-models",
          name: "Configured Models",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [{ id: "known-model", name: "Known Model" }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "configured-models", modelId: "known-model" }
    });

    const callsBeforeGeneration = mock.calls.length;
    const result = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "Explain this file.",
        aiProviderId: "configured-models",
        aiModelId: "not-configured"
      }
    });
    assert.equal(result.response.status, 400);
    assert.match(result.payload.error, /configured model|not configured/i);
    assert.equal(mock.calls.length, callsBeforeGeneration);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("returns measured context usage from hosted provider responses", async () => {
  const projectRoot = createProject();
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: {
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ reply: "The file is a short article.", edits: [] })
        }
      }],
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }
    }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "metered-provider",
          name: "Metered Provider",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [{ id: "metered-model", name: "Metered Model", contextWindowTokens: 32768 }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "metered-provider", modelId: "metered-model" }
    });

    const result = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "What is this file?" }
    });
    assert.equal(result.contextUsage.scope, "last_request");
    assert.equal(result.contextUsage.status, "complete");
    assert.deepEqual(result.contextUsage.usage, {
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: 1280,
      source: "provider_reported"
    });
    assert.equal(result.contextUsage.window.contextWindowTokens, 32768);
    assert.equal(result.contextUsage.window.source, "provider_model_config");
    assert.equal(result.contextUsage.window.percentUsed, 3.9);
    assert.equal("raw" in result, false);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("estimates missing usage from the exact serialized provider request", async () => {
  const projectRoot = createProject();
  fs.writeFileSync(path.join(projectRoot, "appendix.tex"), `\\section{Appendix}\n${"Long project context. ".repeat(5000)}`);
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: {
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({ reply: "Estimated response.", edits: [] })
        }
      }]
    }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "estimated-provider",
          name: "Estimated Provider",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          models: [{ id: "estimated-model", name: "Estimated Model" }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "estimated-provider", modelId: "estimated-model" }
    });

    const result = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "Estimate this request" }
    });
    const exactSerializedRequest = JSON.stringify(mock.calls.at(-1).body);
    const expectedTokens = Math.ceil(Buffer.byteLength(exactSerializedRequest, "utf8") / 3);
    const providerRequest = mock.calls.at(-1).body;
    assert.equal("context_window" in providerRequest, false);
    assert.equal("context_length" in providerRequest, false);
    assert.equal("num_ctx" in providerRequest, false);
    const activeChoice = app.state.ai.models.publicState().activeModel;
    assert.deepEqual(activeChoice.contextWindow, {
      mode: "provider_default",
      source: "provider",
      resourceProfile: null,
      effectiveTokens: null,
      modelMaximumTokens: null
    });
    assert.equal(result.contextUsage.usage.source, "server_estimate");
    assert.equal(result.contextUsage.usage.inputTokens, expectedTokens);
    assert.equal(result.contextUsage.usage.totalTokens, expectedTokens);
    assert.equal(result.contextUsage.truncation.occurred, true);
    assert.ok(result.contextUsage.truncation.reasons.includes("project_context_limit"));
    assert.equal(result.contextUsage.components.find((item) => item.key === "project_context").truncated, true);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("propagates caller cancellation to hosted provider requests", async () => {
  const projectRoot = createProject();
  let capturedSignal = null;
  const aiFetch = async (_url, options = {}) => {
    capturedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const { app, baseUrl } = await startApp(projectRoot, { aiFetch });

  try {
    await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "abortable-provider",
        name: "Abortable provider",
        type: "openai-compatible",
        baseUrl: "https://provider.invalid/v1",
        modelId: "abortable-model",
        models: [{ id: "abortable-model", name: "Abortable model" }],
        activate: true
      }
    });
    const controller = new AbortController();
    const pending = app.state.ai.models.askActiveProvider([
      { role: "user", content: "Wait" }
    ], { signal: controller.signal, timeoutMs: 50 });
    while (!capturedSignal) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(capturedSignal.aborted, true);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("splices provider annotation block rewrites into the mapped source block", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-provider-annotation-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Introduction}",
    "The aim of this lab was to continue the machine learning vulnerability detection work from the last lab.",
    "",
    "\\section{Conclusion}",
    "The aim of the final section is to summarize the results.",
    "\\end{document}",
    ""
  ].join("\n"));
  const mock = await startOpenAiCompatibleMock(({ body }) => {
    const prompt = body.messages?.map((message) => message.content).join("\n") || "";
    if (/LOCALLEAF_OK/u.test(prompt)) {
      return {
        status: 200,
        body: { choices: [{ message: { role: "assistant", content: "LOCALLEAF_OK" } }] }
      };
    }
    assert.match(prompt, /PDF annotation target/);
    assert.match(prompt, /Annotated source block/);
    return {
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "I rewrote the annotated sentence.",
              summary: "Rewrite annotated sentence.",
              edits: [{
                path: "main.tex",
                newText: "The objective of this lab was to continue the machine learning vulnerability detection work from the last lab."
              }]
            })
          }
        }]
      }
    };
  });
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "hosted",
          name: "Hosted",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          apiKey: "test-provider-key",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "hosted", modelId: "kimi-k2.6" }
    });

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "make this sentence use objective instead of aim",
        selectedText: "The aim of this lab was to continue the machine learning vulnerability detection work from the last lab.",
        pdfAnnotation: {
          page: 1,
          x: 120,
          y: 180,
          textPreview: "The aim of this lab was to continue the machine learning vulnerability detection work from the last lab.",
          source: { path: "main.tex", line: 4, column: 1 }
        }
      }
    });
    assert.equal(message.provider.id, "hosted");
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /The objective of this lab/);
    assert.match(message.proposals[0].newText, /The aim of the final section/);
    assert.match(message.proposals[0].newText, /\\begin\{document\}/);
    assert.doesNotMatch(fs.readFileSync(mainPath, "utf8"), /The objective of this lab/);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("sends image annotation context to hosted providers", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-provider-image-annotation-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{figure}",
    "\\centering",
    "\\includegraphics[width=0.75\\linewidth]{diagram.png}",
    "\\caption{Old diagram caption}",
    "\\end{figure}",
    "\\end{document}",
    ""
  ].join("\n"));
  const mock = await startOpenAiCompatibleMock(({ body }) => {
    const prompt = body.messages?.map((message) => message.content).join("\n") || "";
    if (/LOCALLEAF_OK/u.test(prompt)) {
      return {
        status: 200,
        body: { choices: [{ message: { role: "assistant", content: "LOCALLEAF_OK" } }] }
      };
    }
    assert.match(prompt, /Selected PDF element: image/);
    assert.match(prompt, /rendered image or figure region/);
    assert.match(prompt, /\\includegraphics\[width=0\.75\\linewidth\]\{diagram\.png\}/);
    return {
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "I updated the image caption.",
              summary: "Update figure caption.",
              replacements: [{
                find: "\\caption{Old diagram caption}",
                replace: "\\caption{Updated diagram caption}"
              }]
            })
          }
        }]
      }
    };
  });
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/validate", {
      method: "POST",
      body: {
        provider: {
          id: "hosted",
          name: "Hosted",
          type: "openai-compatible",
          baseUrl: mock.baseUrl,
          apiKey: "test-provider-key",
          modelId: "kimi-k2.6",
          models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
        }
      }
    });
    await request(baseUrl, "/api/ai/providers/activate", {
      method: "POST",
      body: { providerId: "hosted", modelId: "kimi-k2.6" }
    });

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "update this image caption",
        selectedText: "Image or figure region selected.",
        pdfAnnotation: {
          page: 1,
          x: 220,
          y: 240,
          elementType: "image",
          targetRect: { left: 80, top: 120, width: 320, height: 180 },
          textPreview: "Image or figure region selected.",
          source: { path: "main.tex", line: 5, column: 1 }
        }
      }
    });
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /Updated diagram caption/);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("falls back to deterministic proposals when no hosted provider is active", async () => {
  const projectRoot = createProject();
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const state = await request(baseUrl, "/api/state");
    assert.equal(state.ai.activeProviderId, null);
    assert.match(state.ai.runtime, /fallback|host-only|deterministic/i);

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this section", selectedText: "We utilize this draft." }
    });
    assert.match(message.reply, /^I prepared an edit to `main\.tex` for review, rewriting common verbose phrases/u);
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /We use this draft/);
    assert.equal(message.contextUsage.status, "not_applicable");
    assert.equal(message.contextUsage.runtime, "deterministic-fallback");
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("falls back to safe proposals when hosted provider generation is malformed", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-provider-malformed-agent-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\title{ML}\n\\begin{document}\n\\maketitle\n\\end{document}\n");
  const mock = await startOpenAiCompatibleMock(() => ({
    status: 200,
    body: { choices: [] }
  }));
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "malformed-agent",
        name: "Malformed Agent",
        type: "openai-compatible",
        baseUrl: mock.baseUrl,
        apiKey: "test-provider-key",
        modelId: "kimi-k2.6",
        models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }],
        activate: true
      }
    });

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "hello\nchange the title from ML to Machine Learning in the first page"
      }
    });

    assert.doesNotMatch(message.reply, /Provider returned a malformed response/i);
    assert.match(
      message.reply,
      /^I prepared an edit to `main\.tex` for review, replacing "ML" with "Machine Learning"\./u
    );
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /\\title\{Machine Learning\}/);
    assert.equal(fs.readFileSync(mainPath, "utf8").includes("Machine Learning"), false);
    assert.equal(message.contextUsage.status, "not_applicable");
    assert.equal(message.contextUsage.runtime, "deterministic-fallback");
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
