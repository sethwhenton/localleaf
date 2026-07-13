const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
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

async function openSlowJsonRequest(url, options = {}) {
  const target = new URL(url);
  const body = JSON.stringify(options.body || {});
  const splitAt = Math.max(1, Math.floor(body.length / 2));
  const firstChunk = body.slice(0, splitAt);
  const finalChunk = body.slice(splitAt);
  let request;
  const responsePromise = new Promise((resolve, reject) => {
    request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(options.headers || {})
      }
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk.toString();
      });
      response.on("end", () => {
        resolve({ response, payload: text ? JSON.parse(text) : {} });
      });
    });
    request.on("error", reject);
  });
  await new Promise((resolve, reject) => {
    request.write(firstChunk, (error) => error ? reject(error) : resolve());
  });
  // Give the server a complete event-loop turn to enter its body reader while
  // deliberately withholding the final bytes.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return {
    finish() {
      request.end(finalChunk);
      return responsePromise;
    },
    destroy() {
      request.destroy();
    }
  };
}

function waitForWsOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForWsClose(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 1005, reason: "" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the collaboration socket to close."));
    }, 3000);
    const onClose = (code, reason) => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

function waitForWsRejection(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out waiting for a revoked collaboration token to be rejected."));
    }, 3000);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("A revoked collaboration token opened a new WebSocket."));
    });
    socket.once("error", finish);
    socket.once("close", finish);
  });
}

async function openAccessRevocationSse(url) {
  let response;
  let buffer = "";
  let resolveRevoked;
  let resolveClosed;
  const accessRevoked = new Promise((resolve) => {
    resolveRevoked = resolve;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const ready = new Promise((resolve, reject) => {
    const request = http.get(url, (nextResponse) => {
      response = nextResponse;
      nextResponse.setEncoding("utf8");
      nextResponse.on("data", (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith("event: access-revoked\n")) {
            const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
            resolveRevoked(dataLine ? JSON.parse(dataLine.slice(6)) : {});
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      nextResponse.once("end", resolveClosed);
      nextResponse.once("close", resolveClosed);
      resolve();
    });
    request.once("error", reject);
  });
  await ready;
  return {
    accessRevoked,
    closed,
    destroy() {
      response?.destroy();
      resolveRevoked(null);
    }
  };
}

function waitForWsMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 3000);
    const onMessage = (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type !== type) return;
      cleanup();
      resolve(payload);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
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
    fixture.app.state.session.maxGuests = 1;
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
      body: { requestId: firstJoin.requestId, role: "maintainer" }
    });
    const duplicate = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: firstJoin.requestId, role: "maintainer" }
    });
    const overCapacity = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: secondJoin.requestId, role: "maintainer" }
    });

    assert.equal(duplicate.response.status, 409);
    assert.match(duplicate.payload.error, /already handled/i);
    assert.equal(overCapacity.response.status, 429);
    assert.equal(fixture.app.state.session.users.length, 2);
  } finally {
    await stopTestApp(fixture);
  }
});

test("a live session admits five guests in addition to the host and rejects the sixth", async () => {
  const fixture = await startTestApp();
  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    const live = await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const requests = [];
    for (let index = 0; index < 6; index += 1) {
      requests.push(await jsonRequest(`${fixture.baseUrl}/api/join`, {
        method: "POST",
        body: { code: fixture.app.state.session.code, name: `Capacity guest ${index + 1}` }
      }));
    }

    for (const request of requests.slice(0, 5)) {
      const approval = await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
        method: "POST",
        headers: hostHeaders,
        body: { requestId: request.requestId, role: "maintainer" }
      });
      assert.equal(approval.user.role, "maintainer");
    }
    const sixthApproval = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: requests[5].requestId, role: "maintainer" }
    });
    const hostState = await jsonRequest(`${fixture.baseUrl}/api/state`, { headers: hostHeaders });

    assert.equal(live.session.maxGuests, 5);
    assert.equal(sixthApproval.response.status, 429);
    assert.match(sixthApproval.payload.error, /full/i);
    assert.equal(hostState.session.users.filter((user) => user.role !== "host").length, 5);
    assert.equal(hostState.session.users.length, 6);
  } finally {
    await stopTestApp(fixture);
  }
});

test("join approval defaults to viewer and rejects unsupported guest roles", async () => {
  const fixture = await startTestApp();
  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const defaultJoin = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Default viewer" }
    });
    const defaultApproval = await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: defaultJoin.requestId }
    });
    assert.equal(defaultApproval.user.role, "viewer");

    const invalidJoin = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Invalid role" }
    });
    const invalidApproval = await rawJsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: invalidJoin.requestId, role: "editor" }
    });
    assert.equal(invalidApproval.response.status, 400);
    assert.match(invalidApproval.payload.error, /viewer or maintainer/i);
    assert.equal(fixture.app.state.session.joinRequests.find((item) => item.id === invalidJoin.requestId)?.status, "pending");
  } finally {
    await stopTestApp(fixture);
  }
});

test("the host can change a viewer into a maintainer and permissions update immediately", async () => {
  const fixture = await startTestApp();
  let guestSocket;
  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const join = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Role guest" }
    });
    const approved = await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: join.requestId, role: "viewer" }
    });
    const status = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const guestHeaders = { "x-localleaf-token": status.token };
    guestSocket = new WebSocket(`ws://127.0.0.1:${fixture.address.port}/collab?token=${encodeURIComponent(status.token)}`);
    const initialSync = waitForWsMessage(guestSocket, "sync_state");
    await waitForWsOpen(guestSocket);
    await initialSync;

    const readable = await jsonRequest(`${fixture.baseUrl}/api/file?path=main.tex`, { headers: guestHeaders });
    const viewerChat = await jsonRequest(`${fixture.baseUrl}/api/chat`, {
      method: "POST",
      headers: guestHeaders,
      body: { message: "Viewer can still chat." }
    });
    const viewerWrite = await rawJsonRequest(`${fixture.baseUrl}/api/file`, {
      method: "POST",
      headers: guestHeaders,
      body: { path: "main.tex", content: "viewer must not write" }
    });
    const viewerCreate = await rawJsonRequest(`${fixture.baseUrl}/api/file/create`, {
      method: "POST",
      headers: guestHeaders,
      body: { path: "viewer-created.tex", content: "viewer must not create" }
    });
    const viewerMainFile = await rawJsonRequest(`${fixture.baseUrl}/api/project/main-file`, {
      method: "POST",
      headers: guestHeaders,
      body: { path: "main.tex" }
    });
    const viewerAi = await rawJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: { path: "main.tex", message: "Explain this document." }
    });
    const unauthorizedRoleChange = await rawJsonRequest(`${fixture.baseUrl}/api/session/guest/role`, {
      method: "POST",
      headers: guestHeaders,
      body: { userId: approved.user.id, role: "maintainer" }
    });
    const invalidRole = await rawJsonRequest(`${fixture.baseUrl}/api/session/guest/role`, {
      method: "POST",
      headers: hostHeaders,
      body: { userId: approved.user.id, role: "editor" }
    });

    assert.match(readable.content, /Security test/);
    assert.equal(viewerChat.author, "Role guest");
    assert.equal(viewerWrite.response.status, 403);
    assert.equal(viewerCreate.response.status, 403);
    assert.equal(viewerMainFile.response.status, 403);
    assert.equal(viewerAi.response.status, 403);
    assert.equal(unauthorizedRoleChange.response.status, 403);
    assert.equal(invalidRole.response.status, 400);
    assert.match(fs.readFileSync(path.join(fixture.projectRoot, "main.tex"), "utf8"), /Security test/);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "viewer-created.tex")), false);

    const roleChangedEvent = waitForWsMessage(guestSocket, "role_changed");
    const changed = await jsonRequest(`${fixture.baseUrl}/api/session/guest/role`, {
      method: "POST",
      headers: hostHeaders,
      body: { userId: approved.user.id, role: "maintainer" }
    });
    assert.equal(changed.user.role, "maintainer");
    assert.equal((await roleChangedEvent).canEdit, true);

    const saved = waitForWsMessage(guestSocket, "file_saved");
    guestSocket.send(JSON.stringify({
      type: "save",
      requestId: "maintainer-role-save",
      filePath: "main.tex",
      newText: "maintainer write"
    }));
    assert.equal((await saved).requestId, "maintainer-role-save");
    const maintainerAi = await jsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: { path: "main.tex", message: "Explain this document." }
    });
    const hostState = await jsonRequest(`${fixture.baseUrl}/api/state`, { headers: hostHeaders });

    assert.equal(fs.readFileSync(path.join(fixture.projectRoot, "main.tex"), "utf8"), "maintainer write");
    assert.ok(maintainerAi.reply);
    assert.equal(hostState.session.users.find((user) => user.id === approved.user.id)?.role, "maintainer");
  } finally {
    guestSocket?.close();
    await stopTestApp(fixture);
  }
});

test("downgrading a maintainer rejects in-flight file and AI requests after their bodies finish", async () => {
  const fixture = await startTestApp();
  let slowFileRequest;
  let slowAiRequest;
  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const join = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "In-flight guest" }
    });
    const approved = await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: join.requestId, role: "maintainer" }
    });
    const status = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const guestHeaders = { "x-localleaf-token": status.token };

    slowFileRequest = await openSlowJsonRequest(`${fixture.baseUrl}/api/file`, {
      headers: guestHeaders,
      body: { path: "main.tex", content: "stale maintainer write" }
    });
    slowAiRequest = await openSlowJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      headers: guestHeaders,
      body: { path: "main.tex", message: "Explain this project after my access changes." }
    });

    await jsonRequest(`${fixture.baseUrl}/api/session/guest/role`, {
      method: "POST",
      headers: hostHeaders,
      body: { userId: approved.user.id, role: "viewer" }
    });

    const [fileResult, aiResult] = await Promise.all([
      slowFileRequest.finish(),
      slowAiRequest.finish()
    ]);
    assert.equal(fileResult.response.statusCode, 403);
    assert.equal(aiResult.response.statusCode, 403);
    assert.match(fs.readFileSync(path.join(fixture.projectRoot, "main.tex"), "utf8"), /Security test/);
  } finally {
    slowFileRequest?.destroy();
    slowAiRequest?.destroy();
    await stopTestApp(fixture);
  }
});

test("the host can remove one guest and immediately revoke that guest token and live connection", async () => {
  const providerStarted = deferred();
  const providerReply = deferred();
  let providerCalls = 0;
  const fixture = await startTestApp({
    aiFetch: async (_url, options = {}) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "LOCALLEAF_OK" } }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      providerStarted.resolve(options.signal);
      return providerReply.promise;
    }
  });
  let guestSocket;
  let guestSse;
  try {
    const hostHeaders = { "x-localleaf-host-token": fixture.app.state.hostToken };
    await jsonRequest(`${fixture.baseUrl}/api/ai/providers/validate`, {
      method: "POST",
      headers: hostHeaders,
      body: {
        provider: {
          id: "revocation-provider",
          name: "Revocation provider",
          type: "openai-compatible",
          baseUrl: "https://revocation-provider.example.test/v1",
          models: [{ id: "revocation-model", name: "Revocation model" }]
        }
      }
    });
    await jsonRequest(`${fixture.baseUrl}/api/ai/providers/activate`, {
      method: "POST",
      headers: hostHeaders,
      body: { providerId: "revocation-provider", modelId: "revocation-model" }
    });
    await jsonRequest(`${fixture.baseUrl}/api/session/start`, {
      method: "POST",
      headers: hostHeaders,
      body: {}
    });
    const join = await jsonRequest(`${fixture.baseUrl}/api/join`, {
      method: "POST",
      body: { code: fixture.app.state.session.code, name: "Removable guest" }
    });
    const approved = await jsonRequest(`${fixture.baseUrl}/api/join/approve`, {
      method: "POST",
      headers: hostHeaders,
      body: { requestId: join.requestId, role: "maintainer" }
    });
    assert.equal(approved.user.role, "maintainer");
    const status = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const guestHeaders = { "x-localleaf-token": status.token };
    guestSocket = new WebSocket(`ws://127.0.0.1:${fixture.address.port}/collab?token=${encodeURIComponent(status.token)}`);
    const initialSync = waitForWsMessage(guestSocket, "sync_state");
    await waitForWsOpen(guestSocket);
    await initialSync;
    guestSse = await openAccessRevocationSse(`${fixture.baseUrl}/events?token=${encodeURIComponent(status.token)}`);

    const pendingAi = rawJsonRequest(`${fixture.baseUrl}/api/agent/message`, {
      method: "POST",
      headers: guestHeaders,
      body: {
        runId: "removed-guest-run",
        path: "main.tex",
        message: "Change Security test to Removed guest edit."
      }
    });
    const guestAiSignal = await providerStarted.promise;

    const revokedEvent = waitForWsMessage(guestSocket, "access_revoked");
    const socketClosed = waitForWsClose(guestSocket);
    const removed = await jsonRequest(`${fixture.baseUrl}/api/session/guest/remove`, {
      method: "POST",
      headers: hostHeaders,
      body: { userId: approved.user.id }
    });
    assert.equal((await revokedEvent).userId, approved.user.id);
    const closeEvent = await socketClosed;
    assert.equal(closeEvent.code, 4003);
    assert.match(closeEvent.reason, /revoked/i);
    const sseRevoked = await guestSse.accessRevoked;
    assert.equal(sseRevoked?.userId, approved.user.id);
    await guestSse.closed;
    await waitForWsRejection(`ws://127.0.0.1:${fixture.address.port}/collab?token=${encodeURIComponent(status.token)}`);
    assert.equal(removed.user.id, approved.user.id);
    assert.equal(guestAiSignal.aborted, true);
    providerReply.resolve(new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({
            reply: "Too late",
            edits: [{
              path: "main.tex",
              replacements: [{ find: "Security test", replace: "Removed guest edit", all: false }]
            }]
          })
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const cancelledAi = await pendingAi;

    const revokedChat = await rawJsonRequest(`${fixture.baseUrl}/api/chat`, {
      method: "POST",
      headers: guestHeaders,
      body: { message: "This must not be sent." }
    });
    const revokedState = await jsonRequest(`${fixture.baseUrl}/api/state`, { headers: guestHeaders });
    const removedJoinStatus = await jsonRequest(`${fixture.baseUrl}/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    const hostState = await jsonRequest(`${fixture.baseUrl}/api/state`, { headers: hostHeaders });
    const unauthorizedRemove = await rawJsonRequest(`${fixture.baseUrl}/api/session/guest/remove`, {
      method: "POST",
      headers: guestHeaders,
      body: { userId: "host" }
    });

    assert.equal(revokedChat.response.status, 403);
    assert.equal(cancelledAi.response.status, 409);
    assert.equal(cancelledAi.payload.code, "AI_RUN_CANCELLED");
    assert.equal(revokedState.project.files, undefined);
    assert.equal(removedJoinStatus.status, "removed");
    assert.equal(removedJoinStatus.token, undefined);
    assert.equal(hostState.session.users.some((user) => user.id === approved.user.id), false);
    assert.equal(unauthorizedRemove.response.status, 403);
  } finally {
    guestSse?.destroy();
    guestSocket?.close();
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
      body: { requestId: join.requestId, role: "maintainer" }
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
      body: { requestId: join.requestId, role: "maintainer" }
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
