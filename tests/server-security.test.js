const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTestLocalLeafServer: createLocalLeafServer } = require("./helpers/localleaf-test-server");

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-security-test-"));
  fs.writeFileSync(
    path.join(root, "main.tex"),
    "\\documentclass{article}\\begin{document}Security test\\end{document}",
    "utf8"
  );
  return root;
}

async function startTestApp(options = {}) {
  const projectRoot = createProject();
  const app = createLocalLeafServer({
    port: 0,
    projectRoot,
    autoStartTunnel: false,
    ...options
  });
  const server = await app.start(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, server, address, baseUrl, projectRoot };
}

async function stopTestApp(fixture) {
  await fixture.app.stop();
  fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
}

async function jsonRequest(url, options = {}) {
  const { response, payload } = await rawJsonRequest(url, options);
  assert.equal(response.ok, true, payload.error || `HTTP ${response.status}`);
  return payload;
}

async function rawJsonRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  return { response, payload };
}

test("production server listens on loopback only", async () => {
  const fixture = await startTestApp();
  try {
    assert.equal(fixture.address.address, "127.0.0.1");
  } finally {
    await stopTestApp(fixture);
  }
});

test("anonymous state exposes join readiness without host diagnostics", async () => {
  const fixture = await startTestApp();
  try {
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: { "x-localleaf-host-token": fixture.app.state.hostToken },
      body: {}
    });

    const state = await jsonRequest(`${fixture.baseUrl}/api/state`);
    assert.equal(state.session.status, "live");
    assert.equal(state.session.code, undefined);
    assert.equal(state.session.inviteUrl, undefined);
    assert.equal(state.session.publicUrl, undefined);
    assert.equal(state.session.network, undefined);
    assert.equal(state.session.tunnel, undefined);
    assert.equal(state.project.root, undefined);
    assert.equal(state.compiler.command, undefined);
    assert.equal(state.compile.pdfPath, undefined);
  } finally {
    await stopTestApp(fixture);
  }
});

test("live sharing session blocks switching to another project", async () => {
  const fixture = await startTestApp();
  const nextProjectRoot = createProject();
  try {
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: { "x-localleaf-host-token": fixture.app.state.hostToken },
      body: {}
    });
    const originalProjectId = fixture.app.state.project.id;

    const response = await fetch(`${fixture.baseUrl}/api/project/open`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-localleaf-host-token": fixture.app.state.hostToken
      },
      body: JSON.stringify({ path: nextProjectRoot })
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.match(payload.error, /stop sharing/i);
    assert.equal(fixture.app.state.project.id, originalProjectId);
    assert.equal(fixture.app.state.session.status, "live");
  } finally {
    fs.rmSync(nextProjectRoot, { recursive: true, force: true });
    await stopTestApp(fixture);
  }
});

test("join approval is idempotent and rechecks session capacity", async () => {
  const fixture = await startTestApp();
  try {
    fixture.app.state.session.maxUsers = 2;
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: { "x-localleaf-host-token": fixture.app.state.hostToken },
      body: {}
    });
    const code = fixture.app.state.session.code;
    const firstJoin = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code, name: "Alex" }
    });
    const secondJoin = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code, name: "Sam" }
    });
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };

    await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: firstJoin.requestId, role: "editor" }
    });
    const duplicate = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: firstJoin.requestId, role: "editor" }
    });
    const overCapacity = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: secondJoin.requestId, role: "editor" }
    });

    assert.equal(duplicate.response.status, 409);
    assert.match(duplicate.payload.error, /already handled/i);
    assert.equal(overCapacity.response.status, 429);
    assert.equal(fixture.app.state.session.users.length, 2);
  } finally {
    await stopTestApp(fixture);
  }
});

test("pending join requests are bounded and reopen after the host handles one", async () => {
  const fixture = await startTestApp();
  try {
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: { "x-localleaf-host-token": fixture.app.state.hostToken },
      body: {}
    });
    const code = fixture.app.state.session.code;
    const pendingRequests = [];

    for (let index = 0; index < 20; index += 1) {
      pendingRequests.push(await jsonRequest(`${fixture.baseUrl}/api/join`, {
        method: "POST",
        body: { code, name: `Guest ${index + 1}` }
      }));
    }

    const overflow = await rawJsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code, name: "Overflow guest" }
    });
    assert.equal(overflow.response.status, 429);
    assert.match(overflow.payload.error, /too many join requests/i);

    await jsonRequest(`${fixture.baseUrl}/api/join/deny`, {
      method: "POST",
      headers: { "x-localleaf-host-token": fixture.app.state.hostToken },
      body: { requestId: pendingRequests[0].requestId }
    });
    const replacement = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code, name: "Replacement guest" }
    });
    assert.ok(replacement.requestId);
  } finally {
    await stopTestApp(fixture);
  }
});

test("approved guests cannot override the host AI provider or approval policy", async () => {
  const providerCalls = [];
  const fixture = await startTestApp({
    aiFetch: async (url, options = {}) => {
      providerCalls.push({ url: String(url), body: JSON.parse(String(options.body || "{}")) });
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "I prepared the requested edit.",
              edits: [{
                path: "main.tex",
                replacements: [{ find: "Security test", replace: "Secure test", all: false }]
              }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    for (const provider of [
      { id: "host-active", name: "Host Active", model: "active-model" },
      { id: "guest-hidden", name: "Guest Hidden", model: "hidden-model" }
    ]) {
      await jsonRequest(`${fixture.baseUrl}/api/ai/providers/validate`, {
        method: "POST",
        headers: hostHeaders,
        body: {
          provider: {
            id: provider.id,
            name: provider.name,
            type: "openai-compatible",
            baseUrl: `https://${provider.id}.example.test/v1`,
            models: [{ id: provider.model, name: provider.model }]
          }
        }
      });
    }
    await jsonRequest(`${fixture.baseUrl}/api/ai/providers/activate`, {
      method: "POST",
      headers: hostHeaders,
      body: { providerId: "host-active", modelId: "active-model" }
    });
    const hostProposalResult = await jsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: hostHeaders,
      body: { path: "main.tex", message: "change Security test to Secure test" }
    });
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const join = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Guest Editor" }
    });
    await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: join.requestId, role: "editor" }
    });
    const joinStatus = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const guestHeaders = { "x-localleaf-token": joinStatus.token };

    const guestState = await jsonRequest(`${fixture.baseUrl}/api/state`, { headers: guestHeaders });
    assert.deepEqual(guestState.ai.providers, []);
    const result = await rawJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: {
        path: "main.tex",
        message: "change Security test to Secure test",
        aiProviderId: "guest-hidden",
        aiModelId: "unknown-model",
        aiPermissions: { askBeforeEdits: false, yoloMode: true, multiFileEdits: true }
      }
    });

    assert.equal(result.response.status, 200);
    assert.equal(providerCalls.at(-1).body.model, "active-model");
    assert.equal(result.payload.provider.id, "host-ai");
    assert.equal(result.payload.proposals[0].approvalRequired, true);
    const guestSessions = await jsonRequest(`${fixture.baseUrl}/api/ai/sessions`, { headers: guestHeaders });
    assert.equal(guestSessions.activeSession.providerId, "host-ai");
    assert.equal(guestSessions.activeSession.providerName, "Host AI");
    assert.equal(guestSessions.activeSession.providerId === "host-active", false);

    const forbiddenApproval = await rawJsonRequest(`${fixture.baseUrl}/api/agent/approval/approve`, {
      method: "POST",
      headers: guestHeaders,
      body: { proposalId: hostProposalResult.proposals[0].id }
    });
    assert.equal(forbiddenApproval.response.status, 403);

    const providerStarted = deferred();
    const providerReply = deferred();
    const proposalCount = fixture.app.state.ai.proposals.size;
    fixture.app.state.ai.models.askActiveProvider = async (_messages, options = {}) => {
      providerStarted.resolve(options.signal);
      return providerReply.promise;
    };
    const pendingGuestRun = rawJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: {
        runId: "revoked-guest-run",
        sessionId: guestSessions.currentSessionId,
        path: "main.tex",
        message: "change Security test to Revoked edit"
      }
    });
    const guestSignal = await providerStarted.promise;
    await jsonRequest(`${fixture.baseUrl}/api/session/stop`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    assert.equal(guestSignal.aborted, true);
    providerReply.resolve({
      provider: { id: "host-active", name: "Host Active" },
      modelId: "active-model",
      content: JSON.stringify({
        reply: "Too late",
        edits: [{ path: "main.tex", replacements: [{ find: "Security test", replace: "Revoked edit" }] }]
      })
    });
    const revokedRun = await pendingGuestRun;
    assert.equal(revokedRun.response.status, 409);
    assert.equal(revokedRun.payload.code, "AI_RUN_CANCELLED");
    assert.equal(fixture.app.state.ai.proposals.size, proposalCount);
    assert.equal(fixture.app.state.ai.guestSessions.size, 0);
  } finally {
    await stopTestApp(fixture);
  }
});

test("approved guests cannot enable AI file creation or approve a host create proposal", async () => {
  let providerCalls = 0;
  const createdContent = "\\section{Host-created chapter}\n";
  const fixture = await startTestApp({
    aiFetch: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              reply: "I prepared the requested project file.",
              edits: [],
              creates: [{ path: "chapters/host.tex", content: createdContent }]
            })
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    await jsonRequest(`${fixture.baseUrl}/api/ai/providers/validate`, {
      method: "POST",
      headers: hostHeaders,
      body: {
        provider: {
          id: "guest-create-provider",
          name: "Guest create provider",
          type: "openai-compatible",
          baseUrl: "https://guest-create-provider.example.test/v1",
          models: [{ id: "create-model", name: "Create model" }]
        }
      }
    });
    await jsonRequest(`${fixture.baseUrl}/api/ai/providers/activate`, {
      method: "POST",
      headers: hostHeaders,
      body: { providerId: "guest-create-provider", modelId: "create-model" }
    });
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const join = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Guest Creator" }
    });
    await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: join.requestId, role: "editor" }
    });
    const joinStatus = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const guestHeaders = { "x-localleaf-token": joinStatus.token };

    const callsBeforeGuestRequest = providerCalls;
    const guestCreate = await rawJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: {
        path: "main.tex",
        message: "Create a new chapters/guest.tex file",
        aiPermissions: {
          askBeforeEdits: false,
          yoloMode: true,
          fileManagement: true
        }
      }
    });
    assert.equal(guestCreate.response.status, 400);
    assert.match(guestCreate.payload.error, /AI permission|Create, rename, move, and delete/i);
    assert.equal(providerCalls, callsBeforeGuestRequest);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "chapters", "guest.tex")), false);

    const hostCreate = await jsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: hostHeaders,
      body: {
        path: "main.tex",
        message: "Create a new chapters/host.tex file",
        aiPermissions: {
          askBeforeEdits: false,
          yoloMode: true,
          fileManagement: true
        }
      }
    });
    assert.equal(hostCreate.proposals.length, 1);
    assert.equal(hostCreate.proposals[0].operation, "create");
    assert.equal(hostCreate.proposals[0].approvalRequired, true);

    const guestApproval = await rawJsonRequest(`${fixture.baseUrl}/api/agent/approval/approve`, {
      method: "POST",
      headers: guestHeaders,
      body: { proposalId: hostCreate.proposals[0].id }
    });
    assert.equal(guestApproval.response.status, 403);
    assert.match(guestApproval.payload.error, /Only the host can approve creation/i);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "chapters", "host.tex")), false);

    const hostApproval = await jsonRequest(`${fixture.baseUrl}/api/agent/approval/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { proposalId: hostCreate.proposals[0].id }
    });
    assert.equal(hostApproval.proposal.status, "applied");
    assert.equal(fs.readFileSync(path.join(fixture.projectRoot, "chapters", "host.tex"), "utf8"), createdContent);
  } finally {
    await stopTestApp(fixture);
  }
});
