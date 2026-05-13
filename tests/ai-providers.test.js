const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createLocalLeafServer } = require("../src/server/index");

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

test("uses hosted provider replacement instructions to create safe LaTeX edit proposals", async () => {
  const projectRoot = createProject();
  const mainPath = path.join(projectRoot, "main.tex");
  const mock = await startOpenAiCompatibleMock(({ body }) => {
    assert.equal(body.model, "kimi-k2.6");
    return {
      status: 200,
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "I found the exact text and prepared the change.",
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

test("falls back to deterministic proposals when no hosted provider is active", async () => {
  const projectRoot = createProject();
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const state = await request(baseUrl, "/api/state");
    assert.equal(state.ai.activeProviderId, null);
    assert.match(state.ai.runtime, /fallback|host-only|deterministic/i);

    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this section" }
    });
    assert.match(message.reply, /Rewrite/);
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /We use this draft/);
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
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /\\title\{Machine Learning\}/);
    assert.equal(fs.readFileSync(mainPath, "utf8").includes("Machine Learning"), false);
  } finally {
    await app.stop();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
