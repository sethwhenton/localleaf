const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createTestLocalLeafServer: createLocalLeafServer } = require("./helpers/localleaf-test-server");
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
    const firstASummary = store.summaryState({ root: projectA, name: "Project A", mainFile: "main.tex" });
    assert.equal(firstA.schemaVersion, 2);
    assert.equal(firstASummary.schemaVersion, 2);
    assert.notEqual(firstA.projectKey, firstB.projectKey);
    assert.equal(firstA.sessions[0].title, "First session");
    assert.equal(firstB.sessions[0].title, "First session");
    assert.equal(Object.hasOwn(firstA.sessions[0], "messages"), false);
    assert.equal(Object.hasOwn(firstASummary, "activeSession"), false);
    assert.deepEqual(firstA.activeSession.messages, []);

    const createdA = store.createSession({ root: projectA, name: "Project A" }, {
      title: "Fix title page",
      messages: [{ id: "user-a", role: "user", message: "This client transcript must be ignored" }]
    });
    const sessionA = createdA.activeSession;
    assert.equal(sessionA.title, "Fix title page");
    assert.equal(sessionA.messageCount, 0);
    assert.deepEqual(sessionA.messages, []);

    store.beginRun({ root: projectA, name: "Project A" }, sessionA.id, {
      runId: "run-a",
      clientMessageId: "user-a",
      message: "Update the author name"
    });
    store.finalizeRun({ root: projectA, name: "Project A" }, sessionA.id, {
      runId: "run-a",
      assistantMessage: { id: "assistant-a", role: "assistant", message: "Done" }
    });

    const secondStore = createAiSessionStore({ root: storeRoot });
    const restoredA = secondStore.publicState({ root: projectA, name: "Project A" });
    const restoredB = secondStore.publicState({ root: projectB, name: "Project B" });
    assert.equal(restoredA.activeSession.title, "Fix title page");
    assert.equal(restoredA.activeSession.messages.some((message) => message.message === "Update the author name"), true);
    assert.equal(restoredB.sessions.some((session) => session.title === "Fix title page"), false);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test("AI session store persists create operations with mandatory approval", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-create-operation-"));
  const projectRoot = makeProject("localleaf-ai-session-create-project-", "Create operation test");
  const project = { root: projectRoot, name: "Create operation project", mainFile: "main.tex" };

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const initial = store.publicState(project);
    const sessionId = initial.currentSessionId;
    store.beginRun(project, sessionId, {
      runId: "create-operation-run",
      clientMessageId: "create-operation-user",
      message: "Create chapters/introduction.tex"
    });
    store.finalizeRun(project, sessionId, {
      runId: "create-operation-run",
      assistantMessage: {
        id: "create-operation-assistant",
        role: "assistant",
        message: "The file is ready for host approval.",
        proposals: [{
          id: "create-operation-proposal",
          operation: "create",
          path: "chapters/introduction.tex",
          status: "proposed",
          approvalRequired: false,
          newText: "\\section{Introduction}\n"
        }]
      }
    });

    const restored = createAiSessionStore({ root: storeRoot }).publicState(project);
    const assistant = restored.activeSession.messages.find((message) => message.id === "create-operation-assistant");
    assert.ok(assistant);
    assert.equal(assistant.proposals.length, 1);
    assert.equal(assistant.proposals[0].operation, "create");
    assert.equal(assistant.proposals[0].path, "chapters/introduction.tex");
    assert.equal(assistant.proposals[0].approvalRequired, true);
    assert.equal(assistant.proposals[0].newText, "\\section{Introduction}\n");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session store redacts unexpected credential-shaped fields", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-redact-"));
  const projectRoot = makeProject("localleaf-ai-session-secret-", "Secret test");

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const state = store.createSession({ root: projectRoot, name: "Secret test" }, { title: "Provider test" });
    store.updateSession({ root: projectRoot, name: "Secret test" }, state.currentSessionId, {
      providerName: "OpenCode Go",
      messages: [
        {
          id: "forged-client-message",
          role: "assistant",
          message: "Client transcripts are not authoritative.",
          apiKey: "secret-should-not-persist"
        }
      ],
      contextUsage: { providerPayload: "provider-secret-should-not-persist" },
      lastContextUsage: { headers: { authorization: "Bearer should-not-persist" } }
    });
    store.beginRun({ root: projectRoot, name: "Secret test" }, state.currentSessionId, {
      runId: "secret-run",
      clientMessageId: "secret-user",
      message: "Prepare a change"
    });
    store.finalizeRun({ root: projectRoot, name: "Secret test" }, state.currentSessionId, {
      runId: "secret-run",
      assistantMessage: {
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
      },
      contextUsage: {
        status: "complete",
        runtime: "hosted",
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, source: "provider_reported" },
        window: { contextWindowTokens: null, maxOutputTokens: null, percentUsed: null, source: "unknown" },
        measuredAt: "invalid-metadata-secret",
        truncation: { occurred: true, reasons: ["history_limit", "secret source excerpt"] },
        components: [{ key: "secret prompt excerpt", originalChars: 50, includedChars: 20, truncated: true }],
        providerPayload: { apiKey: "context-secret-should-not-persist" }
      },
      result: {
        runtime: "hosted-provider",
        modelId: "safe-model-id",
        provider: {
          id: "safe-provider-id",
          name: "Safe provider name",
          apiKey: "run-result-secret-should-not-persist"
        },
        rawProviderPayload: { authorization: "run-result-header-should-not-persist" }
      }
    });

    const restored = createAiSessionStore({ root: storeRoot }).publicState({ root: projectRoot, name: "Secret test" });
    assert.equal(restored.activeSession.messages.some((message) => message.id === "forged-client-message"), false);
    assert.equal(restored.activeSession.providerName, "OpenCode Go");
    assert.equal(restored.activeSession.lastContextUsage.usage.totalTokens, 10);
    assert.equal(restored.activeSession.lastContextUsage.window.contextWindowTokens, null);
    assert.equal(restored.activeSession.lastContextUsage.window.maxOutputTokens, null);
    assert.equal(restored.activeSession.lastContextUsage.window.percentUsed, null);
    assert.match(restored.activeSession.lastContextUsage.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(restored.activeSession.lastContextUsage.truncation.reasons, ["history_limit"]);
    assert.equal(restored.activeSession.lastContextUsage.components[0].key, "other");
    assert.equal(restored.activeSession.changeCount, 1);
    const restoredRun = createAiSessionStore({ root: storeRoot }).getRun(
      { root: projectRoot, name: "Secret test" },
      state.currentSessionId,
      "secret-run"
    );
    assert.equal(restoredRun.sessionId, state.currentSessionId);
    assert.equal(restoredRun.userMessage.message, "Prepare a change");
    assert.equal(restoredRun.assistantMessage.message, "Prepared a change.");
    assert.equal(restoredRun.resultMetadata.runtime, "hosted-provider");
    assert.equal(restoredRun.resultMetadata.provider.id, "safe-provider-id");
    assert.equal(Object.hasOwn(restoredRun.resultMetadata.provider, "apiKey"), false);
    const storedText = fs.readFileSync(store.filePath, "utf8");
    assert.equal(storedText.includes("secret-should-not-persist"), false);
    assert.equal(storedText.includes("should-not-persist"), false);
    assert.equal(storedText.includes("provider-secret-should-not-persist"), false);
    assert.equal(storedText.includes("context-secret-should-not-persist"), false);
    assert.equal(storedText.includes("invalid-metadata-secret"), false);
    assert.equal(storedText.includes("secret source excerpt"), false);
    assert.equal(storedText.includes("secret prompt excerpt"), false);
    assert.equal(storedText.includes("run-result-secret-should-not-persist"), false);
    assert.equal(storedText.includes("run-result-header-should-not-persist"), false);
    assert.match(storedText, /OpenCode Go/);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session rename is revision-checked and preserves context usage", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-rename-"));
  const projectRoot = makeProject("localleaf-ai-session-rename-project-", "Rename test");
  const project = { root: projectRoot, name: "Rename test" };

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const initial = store.publicState(project);
    const sessionId = initial.currentSessionId;
    store.beginRun(project, sessionId, {
      runId: "rename-run",
      clientMessageId: "rename-user",
      message: "Draft a better title"
    });
    const completed = store.finalizeRun(project, sessionId, {
      runId: "rename-run",
      assistantMessage: "Done",
      contextUsage: {
        status: "complete",
        runtime: "local",
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, source: "provider_reported" },
        window: { contextWindowTokens: 4096, maxOutputTokens: 512, percentUsed: 0.6, source: "local_runtime" },
        history: { availableTurns: 0, includedTurns: 0, droppedTurns: 0 },
        truncation: { occurred: false, reasons: [] },
        components: []
      }
    });
    const beforeRename = completed.activeSession;
    assert.equal(beforeRename.lastContextUsage.runId, "rename-run");
    assert.equal(beforeRename.lastContextUsage.sessionId, sessionId);
    assert.match(beforeRename.lastContextUsage.measuredAt, /^\d{4}-\d{2}-\d{2}T/);

    const renamed = store.renameSession(project, sessionId, {
      title: "  Better   title  ",
      expectedRevision: beforeRename.revision
    });
    assert.equal(renamed.activeSession.title, "Better title");
    assert.equal(renamed.activeSession.titleSource, "manual");
    assert.equal(renamed.activeSession.revision, beforeRename.revision + 1);
    assert.equal(renamed.activeSession.lastContextUsage.usage.totalTokens, 24);
    renamed.sessions.find((session) => session.id === sessionId).lastContextUsage.usage.totalTokens = 888;
    assert.equal(store.getSession(project, sessionId).lastContextUsage.usage.totalTokens, 24);
    renamed.activeSession.lastContextUsage.usage.totalTokens = 999;
    assert.equal(store.getSession(project, sessionId).lastContextUsage.usage.totalTokens, 24);

    assert.throws(
      () => store.renameSession(project, sessionId, { title: "Stale", expectedRevision: beforeRename.revision }),
      (error) => error.code === "AI_SESSION_REVISION"
    );
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session runs append once and exclude concurrent project runs", () => {
  const projectRoot = makeProject("localleaf-ai-session-running-", "Run test");
  const project = { root: projectRoot, name: "Run test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const firstId = store.publicState(project).currentSessionId;
    const secondId = store.createSession(project).currentSessionId;
    store.activateSession(project, firstId);

    store.beginRun(project, firstId, {
      runId: "run-one",
      clientMessageId: "user-one",
      message: "First request"
    });
    store.beginRun(project, firstId, {
      runId: "run-one",
      clientMessageId: "user-one",
      message: "First request"
    });
    assert.equal(store.getSession(project, firstId).messages.filter((message) => message.id === "user-one").length, 1);
    assert.equal(store.getSession(project, firstId).runStatus, "running");

    assert.throws(
      () => store.beginRun(project, secondId, {
        runId: "run-two",
        clientMessageId: "user-two",
        message: "Second request"
      }),
      (error) => error.code === "AI_RUN_BUSY"
    );
    assert.throws(
      () => store.deleteSession(project, firstId),
      (error) => error.code === "AI_SESSION_BUSY"
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI run metadata updates safe session fields without persisting credentials", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-run-metadata-"));
  const projectRoot = makeProject("localleaf-ai-session-run-metadata-project-", "Metadata test");
  const project = { root: projectRoot, name: "Metadata test" };

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const sessionId = store.publicState(project).currentSessionId;
    const runInput = {
      runId: "metadata-run",
      clientMessageId: "metadata-user",
      message: "Use this model",
      metadata: {
        providerId: "openai-compatible",
        providerName: "Hosted provider",
        modelId: "writing-model",
        modelName: "Writing model",
        permissionMode: "yolo",
        apiKey: "metadata-secret-must-not-persist",
        headers: { authorization: "Bearer metadata-secret" }
      }
    };
    const running = store.beginRun(project, sessionId, runInput);
    assert.equal(running.activeSession.providerId, "");
    assert.equal(running.activeSession.modelId, "");
    const completed = store.finalizeRun(project, sessionId, {
      runId: runInput.runId,
      assistantMessage: "Done",
      metadata: runInput.metadata
    });
    assert.equal(completed.activeSession.providerId, "openai-compatible");
    assert.equal(completed.activeSession.providerName, "Hosted provider");
    assert.equal(completed.activeSession.modelId, "writing-model");
    assert.equal(completed.activeSession.modelName, "Writing model");
    assert.equal(completed.activeSession.permissionMode, "yolo");
    assert.equal(fs.readFileSync(store.filePath, "utf8").includes("metadata-secret"), false);
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI run completion stays with its origin and marks inactive sessions unread", () => {
  const projectRoot = makeProject("localleaf-ai-session-background-", "Background test");
  const project = { root: projectRoot, name: "Background test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const originId = store.publicState(project).currentSessionId;
    const visibleId = store.createSession(project, { title: "Visible" }).currentSessionId;
    store.activateSession(project, originId);
    store.beginRun(project, originId, {
      runId: "background-run",
      clientMessageId: "background-user",
      message: "Finish in the background"
    });
    store.activateSession(project, visibleId);

    const completed = store.finalizeRun(project, originId, {
      runId: "background-run",
      assistantMessage: { id: "background-assistant", message: "Background done" }
    });
    const originSummary = completed.sessions.find((session) => session.id === originId);
    assert.equal(completed.currentSessionId, visibleId);
    assert.deepEqual(completed.activeSession.messages, []);
    assert.equal(originSummary.runStatus, "idle");
    assert.equal(originSummary.unread, true);
    assert.equal(store.getSession(project, originId).messages.filter((message) => message.id === "background-assistant").length, 1);

    const completedRevision = store.getSession(project, originId).revision;
    store.finalizeRun(project, originId, {
      runId: "background-run",
      assistantMessage: { id: "background-assistant-duplicate", message: "Duplicate" }
    });
    assert.equal(store.getSession(project, originId).revision, completedRevision);
    assert.equal(store.getSession(project, originId).messages.some((message) => message.message === "Duplicate"), false);

    const activated = store.activateSession(project, originId);
    assert.equal(activated.activeSession.unread, false);
    assert.equal(activated.activeSession.messages.some((message) => message.message === "Background done"), true);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cancelled and failed AI runs are terminal and late completions are ignored", () => {
  const projectRoot = makeProject("localleaf-ai-session-terminal-", "Terminal test");
  const project = { root: projectRoot, name: "Terminal test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const cancelledId = store.publicState(project).currentSessionId;
    store.beginRun(project, cancelledId, {
      runId: "cancelled-run",
      clientMessageId: "cancelled-user",
      message: "Cancel this"
    });
    const cancelled = store.cancelRun(project, cancelledId, { runId: "cancelled-run" });
    assert.equal(cancelled.activeSession.runStatus, "idle");
    const cancelledRevision = cancelled.activeSession.revision;
    store.cancelRun(project, cancelledId, { runId: "cancelled-run" });
    store.finalizeRun(project, cancelledId, {
      runId: "cancelled-run",
      assistantMessage: "This arrived too late"
    });
    assert.equal(store.getSession(project, cancelledId).revision, cancelledRevision);
    assert.equal(store.getSession(project, cancelledId).messages.some((message) => message.message === "This arrived too late"), false);
    assert.doesNotThrow(() => store.deleteSession(project, cancelledId));

    const failedId = store.publicState(project).currentSessionId;
    store.beginRun(project, failedId, {
      runId: "failed-run",
      clientMessageId: "failed-user",
      message: "This will fail"
    });
    const failed = store.failRun(project, failedId, {
      runId: "failed-run",
      contextUsage: {
        status: "failed",
        runtime: "local",
        usage: { source: "unavailable" },
        window: { source: "unknown" }
      }
    });
    assert.equal(failed.activeSession.runStatus, "interrupted");
    assert.equal(failed.activeSession.lastContextUsage.status, "failed");
    const failedRevision = failed.activeSession.revision;
    store.failRun(project, failedId, { runId: "failed-run" });
    assert.equal(store.getSession(project, failedId).revision, failedRevision);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session limit rejects session 31 without evicting existing sessions", () => {
  const projectRoot = makeProject("localleaf-ai-session-limit-", "Limit test");
  const project = { root: projectRoot, name: "Limit test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const originalId = store.publicState(project).currentSessionId;
    for (let index = 2; index <= 30; index += 1) {
      store.createSession(project, { title: `Session ${index}` });
    }
    const atLimit = store.summaryState(project);
    assert.equal(atLimit.sessions.length, 30);
    assert.equal(atLimit.sessions.some((session) => session.id === originalId), true);
    assert.throws(
      () => store.createSession(project, { title: "Session 31" }),
      (error) => error.code === "AI_SESSION_LIMIT"
    );
    const afterRejectedCreate = store.summaryState(project);
    assert.equal(afterRejectedCreate.sessions.length, 30);
    assert.equal(afterRejectedCreate.sessions.some((session) => session.id === originalId), true);
    assert.throws(
      () => store.forkSession(project, originalId),
      (error) => error.code === "AI_SESSION_LIMIT"
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("forked AI sessions copy the transcript but reset run and context state", () => {
  const projectRoot = makeProject("localleaf-ai-session-fork-", "Fork test");
  const project = { root: projectRoot, name: "Fork test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const sourceId = store.publicState(project).currentSessionId;
    store.beginRun(project, sourceId, {
      runId: "source-run",
      clientMessageId: "source-user",
      message: "Source prompt"
    });
    store.finalizeRun(project, sourceId, {
      runId: "source-run",
      assistantMessage: { id: "source-assistant", message: "Source reply" },
      contextUsage: {
        status: "complete",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, source: "server_estimate" },
        window: { source: "unknown" }
      }
    });

    const forked = store.forkSession(project, sourceId);
    assert.notEqual(forked.currentSessionId, sourceId);
    assert.equal(forked.activeSession.parentSessionId, sourceId);
    assert.equal(forked.activeSession.title, "Fork: Source prompt");
    assert.deepEqual(
      forked.activeSession.messages.map((message) => [message.role, message.message]),
      [["user", "Source prompt"], ["assistant", "Source reply"]]
    );
    assert.equal(forked.activeSession.lastContextUsage, null);
    assert.equal(forked.activeSession.runStatus, "idle");
    assert.equal(forked.activeSession.unread, false);
    assert.equal(forked.activeSession.revision, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("persisted legacy sessions migrate lazily and stale running work becomes interrupted", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-migrate-"));
  const projectRoot = makeProject("localleaf-ai-session-migrate-project-", "Migration test");
  const project = { root: projectRoot, name: "Migration test" };
  const projectKey = projectKeyForRoot(projectRoot);
  const filePath = path.join(storeRoot, "sessions.json");
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    projects: {
      [projectKey]: {
        key: projectKey,
        name: "Old migration name",
        root: projectRoot,
        currentSessionId: "legacy-session",
        sessions: [{
          id: "legacy-session",
          projectKey,
          title: "Legacy transcript",
          revision: "not-a-number",
          messages: [{ id: "legacy-user", role: "user", message: "Keep this message", apiKey: "discard-me" }],
          runLedger: [{ runId: "stale-run", clientMessageId: "legacy-user", status: "running", startedAt: 123 }]
        }]
      }
    }
  }), "utf8");

  try {
    const store = createAiSessionStore({ root: storeRoot });
    const migrated = store.publicState(project);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.projectName, "Migration test");
    assert.equal(migrated.activeSession.revision, 1);
    assert.equal(migrated.activeSession.runStatus, "interrupted");
    assert.equal(migrated.activeSession.messages[0].message, "Keep this message");
    assert.equal(Object.hasOwn(migrated.activeSession.messages[0], "apiKey"), false);
    assert.doesNotThrow(() => store.beginRun(project, "legacy-session", {
      runId: "recovery-run",
      clientMessageId: "recovery-user",
      message: "Continue after restart"
    }));

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.projects[projectKey].sessions[0].runLedger[0].status, "interrupted");
    assert.equal(persisted.projects[projectKey].sessions[0].runStatus, "running");
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("legacy session import is sanitized, idempotent, and can select the imported transcript", () => {
  const projectRoot = makeProject("localleaf-ai-session-import-", "Import test");
  const project = { root: projectRoot, name: "Import test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const imported = store.importLegacySessions(project, [{
      id: "legacy-import",
      title: "Imported chat",
      messages: [{
        id: "legacy-message",
        role: "user",
        message: "Imported prompt",
        headers: { authorization: "discard" }
      }],
      runStatus: "running",
      runLedger: [{ runId: "legacy-import-run", status: "running" }],
      lastContextUsage: {
        status: "complete",
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, source: "server_estimate" },
        window: { source: "unknown" },
        measuredAt: "2026-07-11T10:00:00.000Z",
        rawProviderResponse: { secret: "discard" }
      }
    }], "legacy-import");
    assert.equal(imported.currentSessionId, "legacy-import");
    assert.equal(imported.activeSession.messages[0].message, "Imported prompt");
    assert.equal(Object.hasOwn(imported.activeSession.messages[0], "headers"), false);
    assert.equal(imported.activeSession.runStatus, "interrupted");
    assert.equal(imported.activeSession.lastContextUsage.measuredAt, "2026-07-11T10:00:00.000Z");

    const repeated = store.importLegacySessions(project, [{ id: "legacy-import", title: "Duplicate" }], "legacy-import");
    assert.equal(repeated.sessions.filter((session) => session.id === "legacy-import").length, 1);
    assert.equal(repeated.activeSession.title, "Imported chat");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("legacy session import keeps the first occurrence of duplicate incoming IDs", () => {
  const projectRoot = makeProject("localleaf-ai-session-import-duplicates-", "Import duplicate test");
  const project = { root: projectRoot, name: "Import duplicate test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const sharedPrefix = "x".repeat(80);
    const imported = store.importLegacySessions(project, [
      { id: "duplicate-id", title: "First copy", messages: [] },
      { id: "duplicate-id", title: "Second copy", messages: [] },
      { id: `${sharedPrefix}-first`, title: "First truncated ID", messages: [] },
      { id: `${sharedPrefix}-second`, title: "Second truncated ID", messages: [] }
    ], "duplicate-id");

    assert.equal(imported.sessions.filter((session) => session.id === "duplicate-id").length, 1);
    assert.equal(imported.sessions.find((session) => session.id === "duplicate-id").title, "First copy");
    assert.equal(imported.sessions.filter((session) => session.id === sharedPrefix).length, 1);
    assert.equal(imported.sessions.find((session) => session.id === sharedPrefix).title, "First truncated ID");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("legacy migration can replace the untouched bootstrap session with all 30 sessions", () => {
  const projectRoot = makeProject("localleaf-ai-session-legacy-limit-", "Legacy limit");
  const project = { root: projectRoot, name: "Legacy limit" };

  try {
    const store = createAiSessionStore({ memory: true });
    const legacy = Array.from({ length: 30 }, (_, index) => ({
      id: `legacy-${index + 1}`,
      title: `Legacy ${index + 1}`,
      messages: []
    }));
    const migrated = store.importLegacySessions(project, legacy, "legacy-30");
    assert.equal(migrated.sessions.length, 30);
    assert.equal(migrated.currentSessionId, "legacy-30");
    assert.equal(migrated.sessions.some((session) => session.title === "New session"), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("deleting AI sessions selects a remaining session and replaces the final one with a blank session", () => {
  const projectRoot = makeProject("localleaf-ai-session-delete-", "Delete test");
  const project = { root: projectRoot, name: "Delete test" };

  try {
    const store = createAiSessionStore({ memory: true });
    const firstId = store.publicState(project).currentSessionId;
    const second = store.createSession(project, { title: "Second" });
    const secondId = second.currentSessionId;
    assert.throws(
      () => store.deleteSession(project, secondId, { expectedRevision: second.activeSession.revision + 1 }),
      (error) => error.code === "AI_SESSION_REVISION"
    );
    const afterSecondDelete = store.deleteSession(project, secondId, { expectedRevision: second.activeSession.revision });
    assert.equal(afterSecondDelete.currentSessionId, firstId);
    assert.equal(afterSecondDelete.sessions.length, 1);

    assert.throws(
      () => store.deleteSession(project, "missing-session"),
      (error) => error.code === "AI_SESSION_NOT_FOUND"
    );
    const afterLastDelete = store.deleteSession(project, firstId);
    assert.equal(afterLastDelete.sessions.length, 1);
    assert.notEqual(afterLastDelete.currentSessionId, firstId);
    assert.equal(afterLastDelete.activeSession.title, "New session");
    assert.equal(afterLastDelete.activeSession.titleSource, "automatic");
    assert.deepEqual(afterLastDelete.activeSession.messages, []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AI session mutations report the structured not-found code", () => {
  const projectRoot = makeProject("localleaf-ai-session-errors-", "Error test");
  const project = { root: projectRoot, name: "Error test" };

  try {
    const store = createAiSessionStore({ memory: true });
    store.publicState(project);
    const operations = [
      () => store.activateSession(project, "missing"),
      () => store.updateSession(project, "missing", { title: "Missing" }),
      () => store.renameSession(project, "missing", { title: "Missing" }),
      () => store.deleteSession(project, "missing"),
      () => store.forkSession(project, "missing"),
      () => store.beginRun(project, "missing", { runId: "missing-run", message: "Missing" }),
      () => store.finalizeRun(project, "missing", { runId: "missing-run", assistantMessage: "Missing" }),
      () => store.failRun(project, "missing", { runId: "missing-run" }),
      () => store.cancelRun(project, "missing", { runId: "missing-run" })
    ];
    for (const operation of operations) {
      assert.throws(operation, (error) => error.code === "AI_SESSION_NOT_FOUND");
    }
  } finally {
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
      body: { projectKey: projectAKey, title: "Project A chat" }
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
      body: { projectKey: projectBKey, title: "Project B chat" }
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
    assert.equal(Object.hasOwn(reopenedA.ai.sessions, "activeSession"), false);
    const reopenedDetail = await request(baseUrl, "/api/ai/sessions");
    assert.equal(
      reopenedDetail.activeSession.messages.some((message) => message.message === "Only Project A should see this."),
      false
    );
    assert.equal(Object.hasOwn(reopenedA.ai.sessions.sessions[0], "messages"), false);
  } finally {
    await app.stop();
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test("AI session mutation APIs require the originating project key", async () => {
  const projectA = makeProject("localleaf-ai-session-mutation-a-", "Project A");
  const projectB = makeProject("localleaf-ai-session-mutation-b-", "Project B");
  const { app, baseUrl } = await startApp(projectA);

  try {
    const projectAKey = projectKeyForRoot(projectA);
    const projectBKey = projectKeyForRoot(projectB);
    const openedB = await request(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: projectB }
    });
    const sessionId = openedB.ai.sessions.currentSessionId;
    const mutations = [
      ["/api/ai/sessions/create", { title: "Stale create" }],
      ["/api/ai/sessions/activate", { sessionId }],
      ["/api/ai/sessions/update", { sessionId, title: "Stale update" }],
      ["/api/ai/sessions/rename", { sessionId, title: "Stale rename" }],
      ["/api/ai/sessions/delete", { sessionId }],
      ["/api/ai/sessions/fork", { sessionId }]
    ];

    assert.equal(openedB.ai.sessions.projectKey, projectBKey);
    for (const [requestPath, body] of mutations) {
      const missing = await rawRequest(baseUrl, requestPath, { method: "POST", body });
      assert.equal(missing.response.status, 409, `${requestPath} must reject a missing project key`);
      assert.equal(missing.payload.code, "AI_SESSION_PROJECT_MISMATCH");

      const stale = await rawRequest(baseUrl, requestPath, {
        method: "POST",
        body: { ...body, projectKey: projectAKey }
      });
      assert.equal(stale.response.status, 409, `${requestPath} must reject a stale project key`);
      assert.equal(stale.payload.code, "AI_SESSION_PROJECT_MISMATCH");
    }

    const after = await request(baseUrl, "/api/ai/sessions");
    assert.equal(after.projectKey, projectBKey);
    assert.equal(after.sessions.some((session) => session.title === "Stale create"), false);
    assert.equal(after.sessions.find((session) => session.id === sessionId)?.title, "First session");
  } finally {
    await app.stop();
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});

test("AI session mutations reject a project switch while the request body is pending", async () => {
  const projectA = makeProject("localleaf-ai-session-race-a-", "Project A");
  const projectB = makeProject("localleaf-ai-session-race-b-", "Project B");
  const { app, baseUrl } = await startApp(projectA);
  let pendingRequest;

  try {
    const target = new URL("/api/ai/sessions/create", new URL(baseUrl).origin);
    const requestObserved = once(app.server, "request");
    const pendingResponse = new Promise((resolve, reject) => {
      pendingRequest = http.request(target, {
        method: "POST",
        headers: withHostHeaders(baseUrl, { "content-type": "application/json" })
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ response, payload: JSON.parse(body || "{}") }));
      });
      pendingRequest.on("error", reject);
    });
    pendingRequest.write("{");
    await requestObserved;

    const openedB = await request(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: projectB }
    });
    pendingRequest.end(`"projectKey":${JSON.stringify(openedB.ai.sessions.projectKey)},"title":"Wrong project"}`);

    const result = await pendingResponse;
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.payload.code, "AI_SESSION_PROJECT_MISMATCH");
    const after = await request(baseUrl, "/api/ai/sessions");
    assert.equal(after.sessions.some((session) => session.title === "Wrong project"), false);
  } finally {
    pendingRequest?.destroy();
    await app.stop();
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
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
    const projectKey = projectKeyForRoot(projectRoot);
    await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { projectKey, title: "Host private chat" }
    });
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const join = await rawRequest(new URL(baseUrl).origin, "/api/join", {
      method: "POST",
      body: { name: "Guest Editor", code: live.session.code }
    });
    assert.equal(join.response.status, 200);
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.payload.requestId, role: "maintainer" }
    });
    const joinStatus = await rawRequest(new URL(baseUrl).origin, `/api/join-status?id=${encodeURIComponent(join.payload.requestId)}`);
    const token = joinStatus.payload.token;
    assert.ok(token);

    const guestCreated = await rawRequest(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      guestToken: token,
      body: { projectKey, title: "Guest temporary chat" }
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
      body: { requestId: join.payload.requestId, role: "maintainer" }
    });
    const joinStatus = await rawRequest(new URL(baseUrl).origin, `/api/join-status?id=${encodeURIComponent(join.payload.requestId)}`);
    const token = joinStatus.payload.token;

    const guestSessions = await rawRequest(baseUrl, "/api/ai/sessions", { guestToken: token });
    assert.equal(guestSessions.response.status, 200);
    const guestSessionId = guestSessions.payload.currentSessionId;

    const message = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      guestToken: token,
      body: {
        sessionId: guestSessionId,
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
