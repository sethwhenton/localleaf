const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalLeafServer } = require("../src/server/index");
const { createAiChangeStore } = require("../src/server/ai-changes");
const { createAiSessionStore, projectKeyForRoot } = require("../src/server/ai-sessions");

function makeProject(prefix, body = "Hello") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(rootPath(root, "main.tex"), `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`, "utf8");
  return root;
}

function rootPath(root, relativePath) {
  return path.join(root, relativePath);
}

function hostBaseUrl(app, port) {
  return `http://localhost:${port}/?host=${encodeURIComponent(app.state.hostToken)}`;
}

function buildTestUrl(baseUrl, requestPath) {
  const base = new URL(baseUrl);
  return new URL(requestPath, base.origin).toString();
}

function withHostHeaders(baseUrl, headers = {}) {
  const hostToken = new URL(baseUrl).searchParams.get("host");
  return {
    ...headers,
    ...(hostToken ? { "x-localleaf-host-token": hostToken } : {})
  };
}

function withGuestHeaders(token, headers = {}) {
  return {
    ...headers,
    ...(token ? { "x-localleaf-token": token } : {})
  };
}

async function rawRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, requestPath), {
    method: options.method || "GET",
    headers: options.guestToken
      ? withGuestHeaders(options.guestToken, { "content-type": "application/json", ...(options.headers || {}) })
      : withHostHeaders(baseUrl, { "content-type": "application/json", ...(options.headers || {}) }),
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

test("AI session store keeps sessions scoped to a project root and persists them", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-store-"));
  const projectA = makeProject("localleaf-ai-session-a-", "Project A");
  const projectB = makeProject("localleaf-ai-session-b-", "Project B");

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const firstA = store.publicState({ root: projectA, name: "Project A", mainFile: "main.tex" });
    const firstB = store.publicState({ root: projectB, name: "Project B", mainFile: "main.tex" });
    assert.notEqual(firstA.projectKey, firstB.projectKey);
    assert.equal(firstA.sessions[0].title, "First session");
    assert.equal(firstB.sessions[0].title, "First session");

    const createdA = store.createSession({ root: projectA, name: "Project A" }, {
      title: "Fix title page",
      messages: [
        { id: "welcome", role: "assistant", message: "Welcome" },
        { id: "user-a", role: "user", message: "Update the author name" }
      ]
    });
    const sessionA = createdA.sessions[0];
    assert.equal(sessionA.title, "Fix title page");
    assert.equal(sessionA.messageCount, 1);

    const secondStore = createAiSessionStore({ root: storeRoot });
    const restoredA = secondStore.publicState({ root: projectA, name: "Project A" });
    const restoredB = secondStore.publicState({ root: projectB, name: "Project B" });
    assert.equal(restoredA.sessions[0].title, "Fix title page");
    assert.equal(restoredA.sessions[0].messages.some((message) => message.message === "Update the author name"), true);
    assert.equal(restoredB.sessions.some((session) => session.title === "Fix title page"), false);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test("AI session store redacts unexpected credential-shaped fields", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-redact-"));
  const projectRoot = makeProject("localleaf-ai-session-secret-", "Secret test");

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const state = store.createSession({ root: projectRoot, name: "Secret test" }, { title: "Provider test" });
    store.updateSession({ root: projectRoot, name: "Secret test" }, state.currentSessionId, {
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          message: "Prepared a change.",
          apiKey: "secret-should-not-persist",
          headers: { authorization: "Bearer should-not-persist" },
          proposals: [
            {
              id: "proposal-1",
              path: "main.tex",
              summary: "Small edit",
              provider: { id: "opencode-go", name: "OpenCode Go", apiKey: "provider-secret-should-not-persist" },
              diffHunks: [{ line: 1, lines: [{ type: "added", text: "Hi" }] }]
            }
          ]
        }
      ]
    });

    const storedText = fs.readFileSync(store.filePath, "utf8");
    assert.equal(storedText.includes("secret-should-not-persist"), false);
    assert.equal(storedText.includes("should-not-persist"), false);
    assert.equal(storedText.includes("provider-secret-should-not-persist"), false);
    assert.match(storedText, /OpenCode Go/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session APIs restore the matching project chat after switching projects", async () => {
  const projectA = makeProject("localleaf-ai-session-api-a-", "Project A");
  const projectB = makeProject("localleaf-ai-session-api-b-", "Project B");
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-api-store-"));
  const { app, baseUrl } = await startApp(projectA, { aiSessionRoot: sessionRoot });

  try {
    const publicDenied = await rawRequest(new URL(baseUrl).origin, "/api/ai/sessions");
    assert.equal(publicDenied.response.status, 403);

    const projectAKey = projectKeyForRoot(projectA);
    const projectBKey = projectKeyForRoot(projectB);
    const createdA = await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { title: "Project A chat" }
    });
    const sessionA = createdA.sessions[0];
    await request(baseUrl, "/api/ai/sessions/update", {
      method: "POST",
      body: {
        projectKey: projectAKey,
        sessionId: sessionA.id,
        title: "Project A chat",
        messages: [
          { id: "welcome", role: "assistant", message: "Welcome" },
          { id: "user-a", role: "user", message: "Only Project A should see this." }
        ]
      }
    });

    const openedB = await request(baseUrl, "/api/project/open", { method: "POST", body: { path: projectB } });
    assert.equal(openedB.ai.sessions.projectKey, projectBKey);
    assert.equal(openedB.ai.sessions.sessions.some((session) => session.title === "Project A chat"), false);

    const createdB = await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { title: "Project B chat" }
    });
    assert.equal(createdB.projectKey, projectBKey);
    assert.equal(createdB.sessions[0].title, "Project B chat");

    const staleUpdate = await rawRequest(baseUrl, "/api/ai/sessions/update", {
      method: "POST",
      body: { projectKey: projectAKey, sessionId: sessionA.id, title: "Wrong project" }
    });
    assert.equal(staleUpdate.response.status, 409);

    const reopenedA = await request(baseUrl, "/api/project/open", { method: "POST", body: { path: projectA } });
    assert.equal(reopenedA.ai.sessions.projectKey, projectAKey);
    assert.equal(reopenedA.ai.sessions.sessions[0].title, "Project A chat");
    assert.equal(
      reopenedA.ai.sessions.sessions[0].messages.some((message) => message.message === "Only Project A should see this."),
      true
    );
  } finally {
    await app.stop();
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test("approved guest AI sessions are temporary and separate from host sessions", async () => {
  const projectRoot = makeProject("localleaf-ai-session-guest-", "We utilize this draft.");
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-host-"));
  const { app, baseUrl } = await startApp(projectRoot, {
    aiSessionRoot: sessionRoot,
    aiChangeStore: createAiChangeStore({ memory: true })
  });

  try {
    await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { title: "Host private chat" }
    });
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const join = await rawRequest(new URL(baseUrl).origin, "/api/join", {
      method: "POST",
      body: { name: "Guest Editor", code: live.session.code }
    });
    assert.equal(join.response.status, 200);
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.payload.requestId, role: "editor" }
    });
    const joinStatus = await rawRequest(new URL(baseUrl).origin, `/api/join-status?id=${encodeURIComponent(join.payload.requestId)}`);
    const token = joinStatus.payload.token;
    assert.ok(token);

    const guestCreated = await rawRequest(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      guestToken: token,
      body: { title: "Guest temporary chat" }
    });
    assert.equal(guestCreated.response.status, 200);
    assert.equal(guestCreated.payload.sessions[0].title, "Guest temporary chat");

    const hostSessions = await request(baseUrl, "/api/ai/sessions");
    assert.equal(hostSessions.sessions.some((session) => session.title === "Guest temporary chat"), false);
    assert.equal(hostSessions.sessions.some((session) => session.title === "Host private chat"), true);

    const guestState = await rawRequest(baseUrl, "/api/state", { guestToken: token });
    assert.equal(guestState.response.status, 200);
    assert.equal(guestState.payload.ai.sessions.sessions.some((session) => session.title === "Host private chat"), false);
    assert.equal(guestState.payload.ai.sessions.sessions.some((session) => session.title === "Guest temporary chat"), true);
    assert.deepEqual(guestState.payload.ai.providers, []);

    await request(baseUrl, "/api/session/stop", { method: "POST", body: {} });
    const guestAfterStop = await rawRequest(baseUrl, "/api/ai/sessions", { guestToken: token });
    assert.equal(guestAfterStop.response.status, 403);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test("approved guest AI proposals are saved to shared project Changes", async () => {
  const projectRoot = makeProject("localleaf-ai-shared-changes-", "We utilize this draft.");
  const changeStore = createAiChangeStore({ memory: true });
  const { app, baseUrl } = await startApp(projectRoot, { aiChangeStore: changeStore });

  try {
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const join = await rawRequest(new URL(baseUrl).origin, "/api/join", {
      method: "POST",
      body: { name: "Nia", code: live.session.code }
    });
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.payload.requestId, role: "editor" }
    });
    const joinStatus = await rawRequest(new URL(baseUrl).origin, `/api/join-status?id=${encodeURIComponent(join.payload.requestId)}`);
    const token = joinStatus.payload.token;

    const message = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      guestToken: token,
      body: {
        sessionId: "guest-session-1",
        message: "rewrite this text from utilize to use",
        path: "main.tex",
        aiPermissions: { askBeforeEdits: true, yoloMode: false, rewriteTools: true }
      }
    });
    assert.equal(message.response.status, 200);
    const proposal = message.payload.proposals[0];
    assert.equal(proposal.requester.userName, "Nia");
    assert.equal(proposal.status, "proposed");

    const hostState = await request(baseUrl, "/api/state");
    const hostChange = hostState.ai.proposals.find((item) => item.id === proposal.id);
    assert.equal(hostChange.requester.userName, "Nia");

    const applied = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      guestToken: token,
      body: { proposalId: proposal.id }
    });
    assert.equal(applied.response.status, 200);
    assert.match(fs.readFileSync(rootPath(projectRoot, "main.tex"), "utf8"), /We use this draft/);

    const finalHostState = await request(baseUrl, "/api/state");
    const appliedChange = finalHostState.ai.proposals.find((item) => item.id === proposal.id);
    assert.equal(appliedChange.status, "applied");
    assert.equal(appliedChange.requester.userName, "Nia");
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
