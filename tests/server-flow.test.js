const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");
const WebSocket = require("ws");
const { createTestLocalLeafServer: createLocalLeafServer } = require("./helpers/localleaf-test-server");

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

async function request(baseUrl, path, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, path), {
    method: options.method || "GET",
    headers: withHostHeaders(baseUrl, { "content-type": "application/json", ...(options.headers || {}) }),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

async function rawRequest(baseUrl, path, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, path), {
    method: options.method || "GET",
    headers: withHostHeaders(baseUrl, { "content-type": "application/json", ...(options.headers || {}) }),
    body: options.rawBody !== undefined
      ? options.rawBody
      : options.body
        ? JSON.stringify(options.body)
        : undefined
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : {} };
}

async function binaryRequest(baseUrl, path, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, path), {
    method: options.method || "GET",
    headers: withHostHeaders(baseUrl, options.headers || {}),
    body: options.rawBody
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function publicTunnelRequest(baseUrl, requestPath, options = {}) {
  const parsed = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: requestPath,
        method: options.method || "GET",
        headers: {
          "content-type": "application/json",
          host: "example.trycloudflare.com"
        }
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk.toString();
        });
        response.on("end", () => {
          resolve({
            response,
            payload: text ? JSON.parse(text) : {}
          });
        });
      }
    );
    request.on("error", reject);
    if (options.body) {
      request.write(JSON.stringify(options.body));
    }
    request.end();
  });
}

async function publicTunnelBinaryRequest(baseUrl, requestPath, options = {}) {
  const parsed = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: requestPath,
        method: options.method || "GET",
        headers: {
          host: "example.trycloudflare.com",
          ...(options.headers || {})
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            response,
            buffer: Buffer.concat(chunks)
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function waitForWsOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket open")), 3000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", reject);
  });
}

function waitForWsMessage(socket, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", handleMessage);
      reject(new Error(`Timed out waiting for WebSocket message ${type}`));
    }, 5000);
    function handleMessage(raw) {
      const payload = JSON.parse(raw.toString());
      if (payload.type === type && predicate(payload)) {
        clearTimeout(timeout);
        socket.off("message", handleMessage);
        resolve(payload);
      }
    }
    socket.on("message", handleMessage);
  });
}

async function waitForValue(readValue, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await readValue();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for value. Last value: ${JSON.stringify(lastValue)}`);
}

function openSseConnection(baseUrl, reusedClientId) {
  const parsed = new URL(baseUrl);
  const hostToken = parsed.searchParams.get("host") || "";
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `/events?client=${encodeURIComponent(reusedClientId)}&host=${encodeURIComponent(hostToken)}`,
        method: "GET"
      },
      (response) => {
        response.setEncoding("utf8");
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        resolve({ request, response, read: () => data });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

test("starts a fresh host session after the previous session is stopped", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-host-again-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "host again", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const first = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const pending = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Waiting guest", code: first.session.code }
    });
    assert.equal(pending.response.statusCode, 200);

    const ended = await request(baseUrl, "/api/session/stop", { method: "POST", body: {} });
    assert.equal(ended.session.status, "ended");
    assert.equal(ended.session.inviteUrl, null);
    assert.deepEqual(ended.session.joinRequests, []);

    const oldCode = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Late guest", code: first.session.code }
    });
    assert.equal(oldCode.response.statusCode, 404);

    const restarted = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    assert.equal(restarted.session.status, "live");
    assert.notEqual(restarted.session.id, first.session.id);
    assert.notEqual(restarted.session.code, first.session.code);
    assert.deepEqual(restarted.session.joinRequests, []);
    assert.deepEqual(restarted.session.users.map((user) => user.role), ["host"]);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("keeps a replacement SSE connection registered when an older connection with the same client id closes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-sse-reconnect-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "SSE reconnect", "utf8");
  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let first;
  let replacement;

  try {
    first = await openSseConnection(baseUrl, "reused-client");
    replacement = await openSseConnection(baseUrl, "reused-client");
    first.response.destroy();
    first.request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 40));

    await request(baseUrl, "/api/chat", {
      method: "POST",
      body: { author: "Host", message: "replacement stream remains live" }
    });
    const received = await waitForValue(() => (
      replacement.read().includes("event: chat") && replacement.read().includes("replacement stream remains live")
    ), 1200);
    assert.equal(received, true);
  } finally {
    first?.response.destroy();
    first?.request.destroy();
    replacement?.response.destroy();
    replacement?.request.destroy();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rejects starting a second host session while one is already live", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-double-host-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "one live host session", "utf8");
  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const first = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const second = await rawRequest(baseUrl, "/api/session/start", { method: "POST", body: {} });

    assert.equal(second.response.status, 409);
    assert.match(second.payload.error, /already live/i);
    const current = await request(baseUrl, "/api/state");
    assert.equal(current.session.id, first.session.id);
    assert.equal(current.session.code, first.session.code);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("races tunnel providers and keeps the first verified link", async () => {
  const fixtureRoot = path.resolve(__dirname, "../samples/thesis");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-race-test-"));
  fs.cpSync(fixtureRoot, tempRoot, { recursive: true });
  const checkedUrls = [];
  const checkedChallenges = [];
  const providers = [
    {
      id: "slow",
      name: "Slow Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "setTimeout(() => console.log('https://slow.example.com'), 180); setInterval(() => {}, 1000);"],
      urlPattern: /https:\/\/slow\.example\.com/g,
      hint: "Test slow provider."
    },
    {
      id: "fast",
      name: "Fast Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "setTimeout(() => console.log('https://fast.example.com'), 25); setInterval(() => {}, 1000);"],
      urlPattern: /https:\/\/fast\.example\.com/g,
      hint: "Test fast provider."
    }
  ];
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: providers,
    checkPublicTunnel: async (url, challenge) => {
      checkedUrls.push(url);
      checkedChallenges.push(challenge);
      return url.includes("fast.example.com");
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const state = await waitForValue(async () => {
      const current = await request(baseUrl, "/api/state");
      return current.session.inviteUrl ? current : null;
    });
    assert.equal(state.session.tunnel.providerName, "Fast Tunnel");
    assert.match(state.session.inviteUrl, /^https:\/\/fast\.example\.com\/join\/[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.ok(checkedUrls.includes("https://fast.example.com"));
    assert.ok(checkedChallenges.every((challenge) => /^[a-f0-9]{24}$/.test(challenge)));
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("recognizes a tunnel URL split across process output chunks", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-split-tunnel-output-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "split tunnel output", "utf8");
  const provider = {
    id: "split-output",
    name: "Split Output Tunnel",
    type: "process",
    command: process.execPath,
    args: () => [
      "-e",
      "process.stdout.write('https://split.'); setTimeout(() => process.stdout.write('example.com\\n'), 80); setInterval(() => {}, 1000);"
    ],
    urlPattern: /https:\/\/split\.example\.com/g,
    hint: "Emits its public URL in separate chunks."
  };
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: [provider],
    checkPublicTunnel: async (url) => url === "https://split.example.com"
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/session/start", { method: "POST", body: { providerId: provider.id } });
    const ready = await waitForValue(async () => {
      const current = await request(baseUrl, "/api/state");
      return current.session.inviteUrl ? current : null;
    });
    assert.equal(ready.session.tunnel.providerId, provider.id);
    assert.match(ready.session.inviteUrl, /^https:\/\/split\.example\.com\/join\//);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("starts a session with only the host-selected tunnel provider", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-selected-tunnel-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "selected tunnel provider", "utf8");
  const checkedUrls = [];
  const providers = [
    {
      id: "ignored",
      name: "Ignored Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "setTimeout(() => console.log('https://ignored.example.com'), 5); setInterval(() => {}, 1000);"],
      urlPattern: /https:\/\/ignored\.example\.com/g,
      hint: "Must not start when another provider is selected."
    },
    {
      id: "chosen",
      name: "Chosen Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "setTimeout(() => console.log('https://chosen.example.com'), 50); setInterval(() => {}, 1000);"],
      urlPattern: /https:\/\/chosen\.example\.com/g,
      hint: "Explicit host choice."
    }
  ];
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: providers,
    checkPublicTunnel: async (url) => {
      checkedUrls.push(url);
      return true;
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const pending = await request(baseUrl, "/api/session/start", {
      method: "POST",
      body: { providerId: "chosen" }
    });
    assert.equal(pending.session.tunnel.preferredProviderId, "chosen");
    assert.equal(pending.session.tunnel.selectionMode, "preferred");

    const state = await waitForValue(async () => {
      const current = await request(baseUrl, "/api/state");
      return current.session.inviteUrl ? current : null;
    });
    assert.equal(state.session.tunnel.providerId, "chosen");
    assert.equal(state.session.tunnel.providerName, "Chosen Tunnel");
    assert.match(state.session.inviteUrl, /^https:\/\/chosen\.example\.com\/join\//);
    assert.deepEqual(checkedUrls, ["https://chosen.example.com"]);
    assert.ok(state.session.tunnel.attempts.every((attempt) => attempt.providerId === "chosen"));
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rejects an unavailable tunnel provider without starting a session", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-invalid-tunnel-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "invalid tunnel provider", "utf8");
  const providers = [
    {
      id: "available",
      name: "Available Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "setInterval(() => {}, 1000);"],
      urlPattern: /https:\/\/available\.example\.com/g,
      hint: "Available provider."
    }
  ];
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: providers
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const rejected = await rawRequest(baseUrl, "/api/session/start", {
      method: "POST",
      body: { providerId: "missing" }
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.payload.error, /provider/i);

    const state = await request(baseUrl, "/api/state");
    assert.equal(state.session.status, "idle");
    assert.equal(state.session.tunnel.preferredProviderId, null);
    assert.deepEqual(state.session.tunnel.attempts, []);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("restarts a live tunnel only for the host and explicitly invalidates the previous link", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-tunnel-restart-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "restart tunnel", "utf8");
  const tunnelBaseUrls = [];
  const providers = [
    {
      id: "alpha",
      name: "Alpha Tunnel",
      type: "process",
      command: process.execPath,
      args: ({ baseUrl }) => {
        tunnelBaseUrls.push(baseUrl);
        return ["-e", "setTimeout(() => console.log('https://alpha.example.com'), 20); setInterval(() => {}, 1000);"];
      },
      urlPattern: /https:\/\/alpha\.example\.com/g,
      hint: "Initial provider."
    },
    {
      id: "beta",
      name: "Beta Tunnel",
      type: "process",
      command: process.execPath,
      args: ({ baseUrl }) => {
        tunnelBaseUrls.push(baseUrl);
        return ["-e", "setTimeout(() => console.log('https://beta.example.com'), 60); setInterval(() => {}, 1000);"];
      },
      urlPattern: /https:\/\/beta\.example\.com/g,
      hint: "Replacement provider."
    }
  ];
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: providers,
    checkPublicTunnel: async () => true
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/session/start", {
      method: "POST",
      body: { providerId: "alpha" }
    });
    const initial = await waitForValue(async () => {
      const current = await request(baseUrl, "/api/state");
      return current.session.tunnel.providerId === "alpha" ? current : null;
    });
    const previousInviteUrl = initial.session.inviteUrl;
    const sessionCode = initial.session.code;

    const guestRestart = await publicTunnelRequest(baseUrl, "/api/session/tunnel/restart", {
      method: "POST",
      body: { providerId: "beta" }
    });
    assert.equal(guestRestart.response.statusCode, 403);

    const pending = await request(baseUrl, "/api/session/tunnel/restart", {
      method: "POST",
      body: { providerId: "beta" }
    });
    assert.equal(pending.project.root, tempRoot);
    assert.equal(pending.session.status, "live");
    assert.notEqual(pending.session.code, sessionCode);
    assert.equal(pending.session.inviteUrl, null);
    assert.equal(pending.session.tunnel.preferredProviderId, "beta");
    assert.equal(pending.session.tunnel.previousLinkInvalidated, true);
    assert.match(pending.session.tunnel.detail, /previous invite link was invalidated/i);

    const oldInviteAttempt = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Old link guest", code: sessionCode }
    });
    assert.equal(oldInviteAttempt.response.statusCode, 404);

    const replacement = await waitForValue(async () => {
      const current = await request(baseUrl, "/api/state");
      return current.session.tunnel.providerId === "beta" ? current : null;
    });
    assert.match(replacement.session.inviteUrl, /^https:\/\/beta\.example\.com\/join\//);
    assert.notEqual(replacement.session.inviteUrl, previousInviteUrl);
    assert.equal(replacement.session.code, pending.session.code);
    assert.match(replacement.session.inviteUrl, new RegExp(`${pending.session.code}$`));
    assert.deepEqual(tunnelBaseUrls, [
      `http://127.0.0.1:${port}`,
      `http://127.0.0.1:${port}`
    ]);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ignores obsolete provider verification after a tunnel restart", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-tunnel-generation-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "tunnel generation", "utf8");
  const checks = new Map();
  const provider = (id) => ({
    id,
    name: `${id} Tunnel`,
    type: "process",
    command: process.execPath,
    args: () => ["-e", `console.log('https://${id}.example.com'); setInterval(() => {}, 1000);`],
    urlPattern: new RegExp(`https:\\/\\/${id}\\.example\\.com`, "g"),
    hint: `${id} provider.`
  });
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: [provider("alpha"), provider("beta")],
    checkPublicTunnel: (url) => new Promise((resolve) => checks.set(url, resolve))
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/session/start", {
      method: "POST",
      body: { providerId: "alpha" }
    });
    await waitForValue(() => checks.has("https://alpha.example.com"));

    await request(baseUrl, "/api/session/tunnel/restart", {
      method: "POST",
      body: { providerId: "beta" }
    });
    await waitForValue(() => checks.has("https://beta.example.com"));
    checks.get("https://beta.example.com")(true);
    await waitForValue(async () => {
      const state = await request(baseUrl, "/api/state");
      return state.session.tunnel.providerId === "beta" ? state : null;
    });

    checks.get("https://alpha.example.com")(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalState = await request(baseUrl, "/api/state");
    assert.equal(finalState.session.tunnel.providerId, "beta");
    assert.match(finalState.session.inviteUrl, /^https:\/\/beta\.example\.com\/join\//);
  } finally {
    for (const resolve of checks.values()) resolve(false);
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not let a scheduled tunnel retry replace a newer manual provider race", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-tunnel-retry-generation-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "tunnel retry generation", "utf8");
  let betaStarts = 0;
  const providers = [
    {
      id: "alpha",
      name: "Alpha Tunnel",
      type: "process",
      command: process.execPath,
      args: () => ["-e", "process.exit(2)"],
      urlPattern: /https:\/\/alpha\.example\.com/g,
      hint: "Fails and schedules an automatic retry."
    },
    {
      id: "beta",
      name: "Beta Tunnel",
      type: "process",
      command: process.execPath,
      args: () => {
        betaStarts += 1;
        return ["-e", "console.log('https://beta.example.com'); setInterval(() => {}, 1000);"];
      },
      urlPattern: /https:\/\/beta\.example\.com/g,
      hint: "Host-selected replacement provider."
    }
  ];
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    tunnelProviders: providers,
    checkPublicTunnel: async () => true
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/session/start", {
      method: "POST",
      body: { providerId: "alpha" }
    });
    await waitForValue(async () => {
      const state = await request(baseUrl, "/api/state");
      return state.session.tunnel.status === "Retrying" ? state : null;
    });

    await request(baseUrl, "/api/session/tunnel/restart", {
      method: "POST",
      body: { providerId: "beta" }
    });
    await waitForValue(async () => {
      const state = await request(baseUrl, "/api/state");
      return state.session.tunnel.providerId === "beta" ? state : null;
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    const finalState = await request(baseUrl, "/api/state");
    assert.equal(betaStarts, 1, "the obsolete retry timer must not launch another provider race");
    assert.equal(finalState.session.tunnel.providerId, "beta");
    assert.equal(finalState.session.tunnel.preferredProviderId, "beta");
    assert.match(finalState.session.inviteUrl, /^https:\/\/beta\.example\.com\/join\//);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("acknowledges a WebSocket save request only after its preceding edit is ready to compile", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-collab-save-ack-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "before websocket edit", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async (compileRoot) => {
      const source = fs.readFileSync(path.join(compileRoot, "main.tex"), "utf8");
      return {
        ok: true,
        engine: "test compiler",
        mode: "html",
        logs: [],
        previewHtml: `<p>${source}</p>`,
        pdfPath: null,
        synctexPath: null
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let hostWs;

  try {
    await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    hostWs = new WebSocket(`ws://localhost:${port}/collab?host=${encodeURIComponent(app.state.hostToken)}`);
    const sync = waitForWsMessage(hostWs, "sync_state");
    await waitForWsOpen(hostWs);
    await sync;

    const requestId = "save-before-compile-1";
    const saved = waitForWsMessage(
      hostWs,
      "file_saved",
      (payload) => payload.filePath === "main.tex" && payload.requestId === requestId
    );
    hostWs.send(JSON.stringify({
      type: "edit",
      filePath: "main.tex",
      newText: "edited over websocket before compile"
    }));
    hostWs.send(JSON.stringify({ type: "save", filePath: "main.tex", requestId }));

    const acknowledgement = await saved;
    assert.equal(acknowledgement.requestId, requestId);
    assert.equal(acknowledgement.userId, "host");

    const compiled = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.match(compiled.previewHtml, /edited over websocket before compile/);
    assert.doesNotMatch(compiled.previewHtml, /before websocket edit/);
  } finally {
    hostWs?.close();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not acknowledge a WebSocket save when the requested content cannot be written", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-collab-save-failure-test-"));
  const mainPath = path.join(tempRoot, "main.tex");
  fs.writeFileSync(mainPath, "durable content", "utf8");
  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let hostWs;
  const originalWriteFileSync = fs.writeFileSync;

  try {
    await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    hostWs = new WebSocket(`ws://localhost:${port}/collab?host=${encodeURIComponent(app.state.hostToken)}`);
    const sync = waitForWsMessage(hostWs, "sync_state");
    await waitForWsOpen(hostWs);
    await sync;

    fs.writeFileSync = function writeFileSyncWithFailure(filePath, content, ...args) {
      if (path.resolve(filePath) === path.resolve(mainPath) && String(content) === "cannot persist") {
        const error = new Error("simulated read-only project file");
        error.code = "EPERM";
        throw error;
      }
      return originalWriteFileSync.call(this, filePath, content, ...args);
    };

    const requestId = "save-write-failure-1";
    const outcome = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for correlated save outcome")), 3000);
      const handleMessage = (raw) => {
        const payload = JSON.parse(raw.toString());
        if (payload.requestId !== requestId || !["error", "file_saved"].includes(payload.type)) return;
        clearTimeout(timeout);
        hostWs.off("message", handleMessage);
        resolve(payload);
      };
      hostWs.on("message", handleMessage);
    });
    hostWs.send(JSON.stringify({
      type: "save",
      filePath: "main.tex",
      requestId,
      newText: "cannot persist"
    }));

    const message = await outcome;
    assert.equal(message.type, "error");
    assert.equal(message.requestId, requestId);
    assert.equal(fs.readFileSync(mainPath, "utf8"), "durable content");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    hostWs?.close();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("serializes concurrent compiles so an older job cannot replace the newest PDF", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-queue-test-"));
  fs.writeFileSync(
    path.join(tempRoot, "main.tex"),
    "\\documentclass{article}\\begin{document}Compile queue\\end{document}",
    "utf8"
  );

  const started = [];
  const releases = [];
  const artifactRoots = [];
  const fakeCompiler = async () => {
    const number = started.length + 1;
    started.push(number);
    await new Promise((resolve) => {
      releases[number - 1] = resolve;
    });
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-test-artifact-"));
    const pdfPath = path.join(artifactRoot, "main.pdf");
    artifactRoots.push(artifactRoot);
    fs.writeFileSync(pdfPath, Buffer.from(`%PDF-1.4\ncompile-${number}\n%%EOF\n`, "utf8"));
    return {
      ok: true,
      engine: "test compiler",
      mode: "pdf",
      logs: [`compile ${number} complete`],
      previewHtml: `<p>compile ${number}</p>`,
      pdfPath,
      synctexPath: null,
      artifactRoot,
      sourceSnapshotRoot: null,
      stale: false
    };
  };

  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: fakeCompiler
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const firstRequest = request(baseUrl, "/api/compile", { method: "POST", body: {} });
    await waitForValue(() => started.length === 1, 1000);

    const secondRequest = request(baseUrl, "/api/compile", { method: "POST", body: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(started, [1], "the second compile must wait for the active compiler process");

    releases[0]();
    await waitForValue(() => started.length === 2, 1000);
    releases[1]();

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.match(first.previewHtml, /compile 1/);
    assert.match(second.previewHtml, /compile 2/);
    assert.notEqual(first.jobId, second.jobId);

    const state = await request(baseUrl, "/api/state");
    assert.equal(state.compile.status, "success");
    assert.equal(state.compile.jobId, second.jobId);
    assert.equal(state.compile.queuedJobs, 0);
    assert.equal(state.compile.isStale, false);
    assert.match(state.compile.previewHtml, /compile 2/);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.equal(pdf.response.status, 200);
    assert.match(pdf.buffer.toString("utf8"), /compile-2/);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const artifactRoot of artifactRoots) {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("compiles from an immutable project snapshot while files continue changing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-snapshot-test-"));
  const mainFilePath = path.join(tempRoot, "main.tex");
  fs.writeFileSync(mainFilePath, "before compile", "utf8");

  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  let releaseCompile;
  const released = new Promise((resolve) => {
    releaseCompile = resolve;
  });
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async (compileRoot) => {
      signalStarted();
      await released;
      const compiledSource = fs.readFileSync(path.join(compileRoot, "main.tex"), "utf8");
      return {
        ok: true,
        engine: "test compiler",
        mode: "html",
        logs: [],
        previewHtml: `<p>${compiledSource}</p>`,
        pdfPath: null,
        synctexPath: null
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const compiling = request(baseUrl, "/api/compile", { method: "POST", body: {} });
    await started;
    fs.writeFileSync(mainFilePath, "changed during compile", "utf8");
    releaseCompile();

    const result = await compiling;
    assert.match(result.previewHtml, /before compile/);
    assert.doesNotMatch(result.previewHtml, /changed during compile/);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("retires the previous immutable PDF artifact after publishing a newer compile", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-artifact-retire-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "artifact retirement", "utf8");
  const artifactRoots = [];
  let compileNumber = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      compileNumber += 1;
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-test-artifact-"));
      const pdfPath = path.join(artifactRoot, "main.pdf");
      artifactRoots.push(artifactRoot);
      fs.writeFileSync(pdfPath, Buffer.from(`%PDF-1.4\nartifact-${compileNumber}\n%%EOF\n`, "utf8"));
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: `<p>artifact ${compileNumber}</p>`,
        pdfPath,
        synctexPath: null,
        artifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    const firstArtifactRoot = artifactRoots[0];
    assert.equal(fs.existsSync(firstArtifactRoot), true);

    await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(fs.existsSync(firstArtifactRoot), false);
    assert.equal(fs.existsSync(artifactRoots[1]), true);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.match(pdf.buffer.toString("utf8"), /artifact-2/);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const artifactRoot of artifactRoots) {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("labels the last successful PDF as stale when the newest compile fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-stale-pdf-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "stale PDF metadata", "utf8");
  let compileNumber = 0;
  let successfulArtifactRoot = null;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      compileNumber += 1;
      if (compileNumber === 2) throw new Error("deterministic compiler failure");
      successfulArtifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-test-artifact-"));
      const pdfPath = path.join(successfulArtifactRoot, "main.pdf");
      fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\nlast-good\n%%EOF\n", "utf8"));
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: "<p>last good</p>",
        pdfPath,
        synctexPath: null,
        artifactRoot: successfulArtifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const successful = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(successful.status, "success");
    assert.equal(successful.isStale, false);
    assert.equal(successful.pdfPath, "/api/pdf");
    assert.ok(successful.lastSuccessfulAt);
    assert.ok(successful.lastSuccessfulVersion > 0);
    assert.ok(successful.artifactId);

    const failed = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(failed.status, "failed");
    assert.equal(failed.mode, "pdf");
    assert.equal(failed.pdfAvailable, true);
    assert.equal(failed.isStale, true);
    assert.equal(failed.lastSuccessfulAt, successful.lastSuccessfulAt);
    assert.equal(failed.lastSuccessfulVersion, successful.lastSuccessfulVersion);
    assert.equal(failed.artifactId, successful.artifactId);
    assert.notEqual(failed.jobId, successful.jobId);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.match(pdf.buffer.toString("utf8"), /last-good/);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (successfulArtifactRoot) {
      fs.rmSync(successfulArtifactRoot, { recursive: true, force: true });
    }
  }
});

test("does not advertise a missing last-good PDF after its artifact disappears", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-missing-last-good-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "missing last-good PDF metadata", "utf8");
  let compileNumber = 0;
  let successfulArtifactRoot = null;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      compileNumber += 1;
      if (compileNumber === 2) throw new Error("deterministic compiler failure after artifact loss");
      successfulArtifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-missing-last-good-artifact-"));
      const pdfPath = path.join(successfulArtifactRoot, "main.pdf");
      fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\nlast-good-before-loss\n%%EOF\n", "utf8"));
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: "<p>last good before loss</p>",
        pdfPath,
        synctexPath: null,
        artifactRoot: successfulArtifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const successful = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(successful.pdfAvailable, true);
    fs.rmSync(successfulArtifactRoot, { recursive: true, force: true });

    const disappeared = await request(baseUrl, "/api/state");
    assert.equal(disappeared.compile.pdfPath, null);
    assert.equal(disappeared.compile.pdfAvailable, false);

    const failed = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(failed.status, "failed");
    assert.equal(failed.mode, "html");
    assert.equal(failed.pdfPath, null);
    assert.equal(failed.pdfAvailable, false);
    assert.equal(failed.isStale, false);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.equal(pdf.response.status, 404);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (successfulArtifactRoot) {
      fs.rmSync(successfulArtifactRoot, { recursive: true, force: true });
    }
  }
});

test("does not restore or advertise a last-good PDF after its artifact becomes corrupt", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-corrupt-last-good-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "corrupt last-good PDF metadata", "utf8");
  let compileNumber = 0;
  let successfulArtifactRoot = null;
  let successfulPdfPath = null;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      compileNumber += 1;
      if (compileNumber === 2) throw new Error("deterministic compiler failure after artifact corruption");
      successfulArtifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-corrupt-last-good-artifact-"));
      successfulPdfPath = path.join(successfulArtifactRoot, "main.pdf");
      fs.writeFileSync(successfulPdfPath, Buffer.from("%PDF-1.4\nlast-good-before-corruption\n%%EOF\n", "utf8"));
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: "<p>last good before corruption</p>",
        pdfPath: successfulPdfPath,
        synctexPath: null,
        artifactRoot: successfulArtifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const successful = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(successful.pdfAvailable, true);
    fs.writeFileSync(successfulPdfPath, "truncated artifact", "utf8");

    const corrupted = await request(baseUrl, "/api/state");
    assert.equal(corrupted.compile.pdfPath, null);
    assert.equal(corrupted.compile.pdfAvailable, false);

    const failed = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(failed.status, "failed");
    assert.equal(failed.mode, "html");
    assert.equal(failed.pdfPath, null);
    assert.equal(failed.pdfAvailable, false);
    assert.equal(failed.isStale, false);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.equal(pdf.response.status, 404);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (successfulArtifactRoot) fs.rmSync(successfulArtifactRoot, { recursive: true, force: true });
  }
});

test("keeps project compilation host-only for approved guests", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-guest-compile-test-"));
  fs.writeFileSync(
    path.join(tempRoot, "main.tex"),
    "\\documentclass{article}\\begin{document}Host compile only\\end{document}",
    "utf8"
  );
  let compileCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      compileCalls += 1;
      return {
        ok: true,
        engine: "test compiler",
        mode: "html",
        logs: [],
        previewHtml: "<p>compiled</p>",
        pdfPath: null,
        synctexPath: null
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const joined = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Guest editor", code: live.session.code }
    });
    const approved = await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: joined.payload.requestId, role: "maintainer" }
    });
    assert.equal(approved.ok, true);
    const status = await publicTunnelRequest(
      baseUrl,
      `/api/join-status?id=${encodeURIComponent(joined.payload.requestId)}`
    );
    assert.ok(status.payload.token);

    const guestCompile = await publicTunnelRequest(
      baseUrl,
      `/api/compile?token=${encodeURIComponent(status.payload.token)}`,
      { method: "POST", body: {} }
    );
    assert.equal(guestCompile.response.statusCode, 403);
    assert.match(guestCompile.payload.error, /host/i);
    assert.equal(compileCalls, 0);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("delivers host compile completion to an approved guest over WebSocket without EventSource", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-guest-compile-ws-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "compile updates over websocket", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => ({
      ok: true,
      engine: "test compiler",
      mode: "html",
      logs: ["compile completed at C:\\Users\\private-host\\project\\main.tex"],
      previewHtml: "<p>C:\\Users\\private-host\\project\\main.tex</p>",
      pdfPath: null,
      synctexPath: null
    })
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let guestWs;

  try {
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const joined = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Guest editor", code: live.session.code }
    });
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: joined.payload.requestId, role: "maintainer" }
    });
    const status = await publicTunnelRequest(
      baseUrl,
      `/api/join-status?id=${encodeURIComponent(joined.payload.requestId)}`
    );

    guestWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(status.payload.token)}`);
    const sync = waitForWsMessage(guestWs, "sync_state");
    await waitForWsOpen(guestWs);
    await sync;

    const completed = waitForWsMessage(
      guestWs,
      "project_event",
      (payload) => payload.event === "compile" && payload.payload?.status === "success"
    );
    const hostCompile = await request(baseUrl, "/api/compile", { method: "POST", body: {} });

    const message = await completed;
    assert.match(hostCompile.logs.join("\n"), /private-host/);
    assert.match(hostCompile.previewHtml, /private-host/);
    assert.deepEqual(message.payload.logs, ["[LocalLeaf] The host finished compiling the project."]);
    assert.equal(message.payload.previewHtml, "");
    assert.doesNotMatch(JSON.stringify(message.payload), /private-host/);

    const guestState = await publicTunnelRequest(
      baseUrl,
      `/api/state?token=${encodeURIComponent(status.payload.token)}`
    );
    assert.deepEqual(guestState.payload.compile.logs, ["[LocalLeaf] The host finished compiling the project."]);
    assert.equal(guestState.payload.compile.previewHtml, "");
    assert.doesNotMatch(JSON.stringify(guestState.payload.compile), /private-host/);
  } finally {
    guestWs?.close();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("delivers project state changes to an approved guest over WebSocket without EventSource", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-guest-state-ws-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "project state updates over websocket", "utf8");
  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let guestWs;

  try {
    const live = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const joined = await publicTunnelRequest(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "State guest", code: live.session.code }
    });
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: joined.payload.requestId, role: "maintainer" }
    });
    const status = await publicTunnelRequest(
      baseUrl,
      `/api/join-status?id=${encodeURIComponent(joined.payload.requestId)}`
    );

    guestWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(status.payload.token)}`);
    const sync = waitForWsMessage(guestWs, "sync_state");
    await waitForWsOpen(guestWs);
    await sync;

    const updated = waitForWsMessage(
      guestWs,
      "state_update",
      (payload) => payload.state?.project?.files?.some((file) => file.path === "chapter.tex")
    );
    await request(baseUrl, "/api/file/create", {
      method: "POST",
      body: { path: "chapter.tex", content: "\\section{New chapter}" }
    });

    const message = await updated;
    assert.equal(message.state.project.root, "Stored on host computer");
    assert.notEqual(message.state.project.root, tempRoot);
    assert.ok(message.state.project.files.some((file) => file.path === "chapter.tex"));
  } finally {
    guestWs?.close();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not publish compiler output that is not a complete PDF", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-invalid-pdf-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "invalid PDF artifact", "utf8");
  let artifactRoot = null;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-invalid-pdf-artifact-"));
      const pdfPath = path.join(artifactRoot, "main.pdf");
      fs.writeFileSync(pdfPath, "this is not a complete PDF", "utf8");
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: "<p>fallback preview</p>",
        pdfPath,
        synctexPath: null,
        artifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const compiled = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(compiled.status, "failed");
    assert.equal(compiled.mode, "html");
    assert.equal(compiled.pdfPath, null);
    assert.equal(compiled.pdfAvailable, false);
    assert.ok(compiled.logs.some((line) => /invalid or incomplete PDF/i.test(line)));
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (artifactRoot) fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("serves compiled PDFs with byte-range support for embedded viewers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-range-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}PDF\\end{document}", "utf8");
  const pdfBytes = Buffer.from("%PDF-1.4\nLocalLeaf PDF preview bytes\n%%EOF\n", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  fs.writeFileSync(pdfPath, pdfBytes);

  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    version: 1
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const fullPdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.equal(fullPdf.response.status, 200);
    assert.equal(fullPdf.response.headers.get("content-type"), "application/pdf");
    assert.equal(fullPdf.response.headers.get("accept-ranges"), "bytes");
    assert.equal(fullPdf.response.headers.get("content-length"), String(pdfBytes.length));
    assert.match(
      fullPdf.response.headers.get("content-disposition"),
      /^inline; filename=".+\.pdf"; filename\*=UTF-8''.+\.pdf$/
    );
    assert.equal(fullPdf.buffer.toString("utf8"), pdfBytes.toString("utf8"));

    const rangePdf = await binaryRequest(baseUrl, "/api/pdf", {
      headers: { range: "bytes=0-7" }
    });
    assert.equal(rangePdf.response.status, 206);
    assert.equal(rangePdf.response.headers.get("content-range"), `bytes 0-7/${pdfBytes.length}`);
    assert.equal(rangePdf.response.headers.get("content-length"), "8");
    assert.equal(rangePdf.buffer.toString("utf8"), pdfBytes.subarray(0, 8).toString("utf8"));

    const exportedPdf = await binaryRequest(baseUrl, "/api/export/pdf");
    assert.equal(exportedPdf.response.status, 200);
    assert.equal(exportedPdf.response.headers.get("content-type"), "application/pdf");
    assert.match(
      exportedPdf.response.headers.get("content-disposition"),
      /^attachment; filename=".+\.pdf"; filename\*=UTF-8''.+\.pdf$/
    );
    assert.equal(exportedPdf.buffer.toString("utf8"), pdfBytes.toString("utf8"));
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("maps PDF click coordinates to source positions through SyncTeX resolver", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nSource jump\n\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");

  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexResolver: ({ page, x, y, pdfPath: mappedPdf, synctexPath: mappedSynctex }) => {
      assert.equal(page, 1);
      assert.equal(Math.round(x), 40);
      assert.equal(Math.round(y), 70);
      assert.equal(mappedPdf, pdfPath);
      assert.equal(mappedSynctex, synctexPath);
      return { ok: true, path: "main.tex", line: 3, column: 2 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 1
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const state = await request(baseUrl, "/api/state");
    assert.equal(state.compile.sourceMapAvailable, true);
    assert.equal(Object.hasOwn(state.compile, "synctexPath"), false);

    const mapped = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 40, y: 70 }
    });
    assert.deepEqual(mapped, { ok: true, path: "main.tex", line: 3, column: 2 });
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position returns a graceful miss when SyncTeX data is absent", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-miss-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}No map\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));

  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath: null,
    sourceMapAvailable: false,
    version: 1
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const mapped = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 40, y: 70 }
    });
    assert.equal(mapped.ok, false);
    assert.match(mapped.reason, /SyncTeX data is not available/);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position refuses resolver paths outside the editable project", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-safe-path-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-outside-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Safe\\end{document}", "utf8");
  const outsidePath = path.join(outsideRoot, "secret.tex");
  fs.writeFileSync(outsidePath, "private", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");

  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexResolver: () => ({ ok: true, path: outsidePath, line: 1, column: 0 })
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 1,
    artifactId: "compile-safe"
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 20, y: 30, version: 1, artifactId: "compile-safe" }
    });
    assert.equal(mapped.ok, false);
    assert.match(mapped.reason, /editable project source/i);
    assert.equal(Object.hasOwn(mapped, "path"), false);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("PDF source-position rejects a click from a replaced PDF artifact", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-stale-artifact-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Current\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let resolverCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexResolver: () => {
      resolverCalls += 1;
      return { ok: true, path: "main.tex", line: 1, column: 0 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 4,
    artifactId: "compile-new"
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 20, y: 30, version: 2, artifactId: "compile-old" }
    });
    assert.deepEqual(mapped, {
      ok: false,
      state: "stale",
      retryable: true,
      reason: "The PDF preview changed before this source location was mapped. Click the current preview again."
    });
    assert.equal(resolverCalls, 0);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position maps the displayed last-good PDF and labels stale source context", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-last-good-"));
  fs.writeFileSync(path.join(tempRoot, "chapters.tex"), "Old compiled source", "utf8");
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\input{chapters}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexResolver: () => ({ ok: true, path: "chapters.tex", line: 1, column: 4 })
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "failed",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 7,
    artifactId: "compile-last-good",
    isStale: true
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 15, y: 25, version: 7, artifactId: "compile-last-good" }
    });
    assert.deepEqual(mapped, {
      ok: true,
      path: "chapters.tex",
      line: 1,
      column: 4,
      previewState: "stale"
    });
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position distinguishes a pending first compile from a displayed PDF being recompiled", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-source-pending-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Pending\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let resolverCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexResolver: () => {
      resolverCalls += 1;
      return { ok: true, path: "main.tex", line: 1, column: 0 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "running",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 9,
    artifactId: "compile-displayed"
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const displayed = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 10, y: 20, version: 8, artifactId: "compile-displayed" }
    });
    assert.deepEqual(displayed, {
      ok: true,
      path: "main.tex",
      line: 1,
      column: 0,
      previewState: "pending"
    });

    app.state.compile = {
      ...app.state.compile,
      pdfPath: null,
      synctexPath: null,
      sourceMapAvailable: false,
      artifactId: null
    };
    const firstCompile = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 10, y: 20, version: 9 }
    });
    assert.deepEqual(firstCompile, {
      ok: false,
      state: "pending",
      retryable: true,
      reason: "The first PDF is still compiling. Try this click again when the preview is ready."
    });
    assert.equal(resolverCalls, 1);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position falls back to bundled JavaScript when the host has no SyncTeX executable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-js-fallback-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "line one\nline two\nline three\nline four\nline five\nline six\nline seven", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  const unit = 65781.76;
  const synctex = [
    "SyncTeX Version:1",
    `Input:1:${path.join(tempRoot, "main.tex")}`,
    "Output:pdf",
    "Magnification:1000",
    "Unit:1",
    "X Offset:0",
    "Y Offset:0",
    "Content:",
    "{1",
    `[1,1:${Math.round(100 * unit)},${Math.round(200 * unit)}:${Math.round(100 * unit)},${Math.round(10 * unit)},0`,
    `(1,7:${Math.round(100 * unit)},${Math.round(200 * unit)}:${Math.round(100 * unit)},${Math.round(10 * unit)},0`,
    `h1,7:${Math.round(100 * unit)},${Math.round(200 * unit)}:${Math.round(100 * unit)}`,
    ")",
    "]",
    "}1",
    "Postamble:"
  ].join("\n");
  fs.writeFileSync(synctexPath, zlib.gzipSync(Buffer.from(synctex, "utf8")));
  let processCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: `localleaf-missing-synctex-${process.pid}`,
    synctexProcessRunner: async () => {
      processCalls += 1;
      return { ok: false, spawnFailed: true, errorCode: "ENOENT", stdout: "", stderr: "" };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 1,
    artifactId: "compile-js-fallback"
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 150, y: 195, version: 1, artifactId: "compile-js-fallback" }
    });
    assert.deepEqual(mapped, { ok: true, path: "main.tex", line: 7, column: 0 });
    assert.equal(processCalls, 1);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position maps reviewed source through the displayed immutable compile snapshot", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-test-"));
  const sourceText = "\\documentclass{article}\n\\begin{document}\nReviewed change\n\\end{document}";
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "main.tex"), sourceText, "utf8");
  fs.writeFileSync(path.join(snapshotRoot, "main.tex"), sourceText, "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let resolverCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexForwardResolver: (input) => {
      resolverCalls += 1;
      assert.equal(input.sourcePath, path.join(snapshotRoot, "main.tex"));
      assert.equal(input.relativePath, "main.tex");
      assert.equal(input.line, 3);
      assert.equal(input.column, 2);
      assert.equal(input.pdfPath, pdfPath);
      assert.equal(input.synctexPath, synctexPath);
      assert.equal(input.sourceSnapshotRoot, snapshotRoot);
      assert.equal(input.projectRoot, tempRoot);
      assert.equal(input.artifactId, "compile-forward");
      assert.equal(input.version, 4);
      return { ok: true, page: 2, x: 101.5, y: 202.5, width: 33, height: 12 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 4,
    artifactId: "compile-forward"
  };
  const baseUrl = hostBaseUrl(app, port);
  const expectedSourceHash = crypto.createHash("sha256").update(sourceText, "utf8").digest("hex");

  try {
    const stale = await request(baseUrl, "/api/pdf/output-position", {
      method: "POST",
      body: {
        path: "main.tex",
        line: 3,
        column: 2,
        version: 2,
        artifactId: "compile-replaced",
        expectedSourceHash
      }
    });
    assert.deepEqual(stale, {
      ok: false,
      state: "stale",
      retryable: true,
      reason: "The PDF preview changed before this review location was mapped. Review the current PDF again."
    });
    assert.equal(resolverCalls, 0);

    const mapped = await request(baseUrl, "/api/pdf/output-position", {
      method: "POST",
      body: {
        path: "main.tex",
        line: 3,
        column: 2,
        version: 4,
        artifactId: "compile-forward",
        expectedSourceHash
      }
    });
    assert.deepEqual(mapped, {
      ok: true,
      page: 2,
      x: 101.5,
      y: 202.5,
      width: 33,
      height: 12,
      path: "main.tex",
      line: 3,
      column: 2,
      artifactId: "compile-forward",
      version: 4
    });
    assert.equal(resolverCalls, 1);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position discards a forward result after the displayed artifact is replaced", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-stale-after-"));
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  const sourceText = "\\documentclass{article}\n\\begin{document}\nChange\n\\end{document}";
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "main.tex"), sourceText, "utf8");
  fs.writeFileSync(path.join(snapshotRoot, "main.tex"), sourceText, "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let releaseResolver;
  let markResolverStarted;
  const resolverStarted = new Promise((resolve) => { markResolverStarted = resolve; });
  const resolverResult = new Promise((resolve) => { releaseResolver = resolve; });
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexMaxConcurrentLookups: 1,
    synctexForwardResolver: () => {
      markResolverStarted();
      return resolverResult;
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 1,
    artifactId: "compile-before"
  };

  try {
    const pending = request(hostBaseUrl(app, port), "/api/pdf/output-position", {
      method: "POST",
      body: { path: "main.tex", line: 3, column: 0, version: 1, artifactId: "compile-before" }
    });
    await resolverStarted;
    const saturated = await request(hostBaseUrl(app, port), "/api/pdf/output-position", {
      method: "POST",
      body: { path: "main.tex", line: 3, column: 0, version: 1, artifactId: "compile-before" }
    });
    assert.deepEqual(saturated, {
      ok: false,
      state: "busy",
      retryable: true,
      reason: "The host is already handling several PDF lookups. Try Review again in a moment."
    });
    app.state.compile.artifactId = "compile-after";
    releaseResolver({ ok: true, page: 1, x: 20, y: 30, width: 10, height: 5 });
    const mapped = await pending;
    assert.deepEqual(mapped, {
      ok: false,
      state: "stale",
      retryable: true,
      reason: "The PDF preview changed before this review location was mapped. Review the current PDF again."
    });
    assert.equal(Object.hasOwn(mapped, "page"), false);
  } finally {
    releaseResolver?.({ ok: false });
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position parses the first complete SyncTeX view box as top-left geometry", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-cli-"));
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  const sourceText = "\\documentclass{article}\n\\begin{document}\nCLI map\n\\end{document}";
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "main.tex"), sourceText, "utf8");
  fs.writeFileSync(path.join(snapshotRoot, "main.tex"), sourceText, "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let processInput;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: "fake-synctex",
    synctexProcessRunner: async (input) => {
      processInput = input;
      return {
        ok: true,
        stdout: [
          "SyncTeX result begin",
          "Page:3",
          "x:101",
          "y:202",
          "h:90",
          "v:220",
          "W:40",
          "H:15",
          "Page:4",
          "x:1",
          "y:2",
          "h:3",
          "v:4",
          "W:5",
          "H:1",
          "SyncTeX result end"
        ].join("\n"),
        stderr: ""
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 2,
    artifactId: "compile-cli-forward"
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/output-position", {
      method: "POST",
      body: { path: "main.tex", line: 3, column: 4, version: 2, artifactId: "compile-cli-forward" }
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.page, 3);
    assert.equal(mapped.x, 90);
    assert.equal(mapped.y, 205);
    assert.equal(mapped.width, 40);
    assert.equal(mapped.height, 15);
    assert.deepEqual(processInput.args, [
      "view",
      "-i",
      `3:4:${path.join(snapshotRoot, "main.tex")}`,
      "-o",
      pdfPath,
      "-d",
      path.dirname(synctexPath)
    ]);
    assert.equal(processInput.cwd, snapshotRoot);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position requires the reviewed source hash to match the displayed compile snapshot", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-hash-"));
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "current source", "utf8");
  fs.writeFileSync(path.join(snapshotRoot, "main.tex"), "older compiled source", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let resolverCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexForwardResolver: () => {
      resolverCalls += 1;
      return { ok: true, page: 1, x: 1, y: 1, width: 1, height: 1 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "running",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 8,
    artifactId: "compile-last-good"
  };
  const expectedSourceHash = crypto.createHash("sha256").update("current source", "utf8").digest("hex");

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/output-position", {
      method: "POST",
      body: {
        path: "main.tex",
        line: 1,
        column: 0,
        version: 7,
        artifactId: "compile-last-good",
        expectedSourceHash
      }
    });
    assert.deepEqual(mapped, {
      ok: false,
      state: "pending",
      retryable: true,
      recompileRequired: true,
      reason: "The displayed PDF was compiled from a different version of this file. Recompile before reviewing this change."
    });
    assert.equal(resolverCalls, 0);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position rejects traversal and reports missing SyncTeX without invoking the resolver", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-safe-path-"));
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "source", "utf8");
  fs.writeFileSync(path.join(snapshotRoot, "main.tex"), "source", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let resolverCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexForwardResolver: () => {
      resolverCalls += 1;
      return { ok: true, page: 1, x: 1, y: 1, width: 1, height: 1 };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 1,
    artifactId: "compile-safe-forward"
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const traversal = await request(baseUrl, "/api/pdf/output-position", {
      method: "POST",
      body: { path: "../outside.tex", line: 1, column: 0, artifactId: "compile-safe-forward" }
    });
    assert.equal(traversal.ok, false);
    assert.match(traversal.reason, /outside the editable project/i);

    app.state.compile.synctexPath = null;
    app.state.compile.sourceMapAvailable = false;
    const missingMap = await request(baseUrl, "/api/pdf/output-position", {
      method: "POST",
      body: { path: "main.tex", line: 1, column: 0, artifactId: "compile-safe-forward" }
    });
    assert.equal(missingMap.ok, false);
    assert.equal(missingMap.recompileRequired, true);
    assert.match(missingMap.reason, /SyncTeX data is unavailable/i);
    assert.equal(resolverCalls, 0);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF output-position falls back to the bundled forward reader when host SyncTeX is unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-pdf-output-fallback-"));
  const snapshotRoot = path.join(tempRoot, ".compiled-source");
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const relativePath = "synctex-tectonic-minimal.tex";
  const sourceText = fs.readFileSync(path.join(__dirname, "fixtures", relativePath), "utf8");
  fs.writeFileSync(path.join(tempRoot, relativePath), sourceText, "utf8");
  fs.writeFileSync(path.join(snapshotRoot, relativePath), sourceText, "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  const synctexFixture = fs.readFileSync(path.join(__dirname, "fixtures", "synctex-tectonic-minimal.synctex"));
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, zlib.gzipSync(synctexFixture));
  let processCalls = 0;
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: `localleaf-missing-forward-synctex-${process.pid}`,
    synctexProcessRunner: async () => {
      processCalls += 1;
      return { ok: false, spawnFailed: true, errorCode: "ENOENT", stdout: "", stderr: "" };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    sourceSnapshotRoot: snapshotRoot,
    version: 1,
    artifactId: "compile-forward-fallback"
  };

  try {
    const mapped = await request(hostBaseUrl(app, port), "/api/pdf/output-position", {
      method: "POST",
      body: {
        path: relativePath,
        line: 5,
        column: 0,
        version: 1,
        artifactId: "compile-forward-fallback",
        expectedSourceHash: crypto.createHash("sha256").update(sourceText, "utf8").digest("hex")
      }
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.page, 1);
    assert.ok(mapped.x > 0);
    assert.ok(mapped.y > 0);
    assert.ok(mapped.width > 0);
    assert.ok(mapped.height > 0);
    assert.equal(mapped.path, relativePath);
    assert.equal(mapped.artifactId, "compile-forward-fallback");
    assert.equal(processCalls, 1);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PDF source-position reports bounded SyncTeX timeout and spawn failures", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-failures-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Failures\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: "fake-synctex",
    synctexProcessRunner: async ({ x }) => x === 10
      ? { ok: false, timedOut: true, stdout: "", stderr: "" }
      : { ok: false, spawnFailed: true, errorCode: "ENOENT", stdout: "", stderr: "" }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 1,
    artifactId: "compile-failures"
  };
  const baseUrl = hostBaseUrl(app, port);

  try {
    const timedOut = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 10, y: 20, version: 1, artifactId: "compile-failures" }
    });
    assert.deepEqual(timedOut, {
      ok: false,
      state: "unavailable",
      retryable: true,
      reason: "SyncTeX lookup timed out on the host. Try again or recompile the PDF."
    });

    const spawnFailed = await request(baseUrl, "/api/pdf/source-position", {
      method: "POST",
      body: { page: 1, x: 20, y: 20, version: 1, artifactId: "compile-failures" }
    });
    assert.deepEqual(spawnFailed, {
      ok: false,
      state: "unavailable",
      reason: "SyncTeX lookup could not start on the host."
    });
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a slow participant SyncTeX lookup does not block another lookup, HTTP state, or WebSocket heartbeat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-concurrency-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Concurrent\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  let releaseSlow;
  let markSlowStarted;
  const slowStarted = new Promise((resolve) => {
    markSlowStarted = resolve;
  });
  const slowResult = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: "fake-synctex",
    synctexProcessRunner: async ({ x }) => {
      if (x === 10) {
        markSlowStarted();
        return slowResult;
      }
      return {
        ok: true,
        stdout: `Input:${path.join(tempRoot, "main.tex")}\nLine: 2\nColumn: 0\n`,
        stderr: ""
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);
  let guestWs;

  try {
    const session = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    const join = await request(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Async Guest", code: session.session.code }
    });
    await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.requestId, role: "maintainer" }
    });
    const joinStatus = await request(baseUrl, `/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    app.state.compile = {
      ...app.state.compile,
      status: "success",
      mode: "pdf",
      pdfPath,
      synctexPath,
      sourceMapAvailable: true,
      version: 1,
      artifactId: "compile-concurrent"
    };

    guestWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(joinStatus.token)}`);
    const sync = waitForWsMessage(guestWs, "sync_state");
    await waitForWsOpen(guestWs);
    await sync;

    const slowLookup = publicTunnelRequest(
      baseUrl,
      `/api/pdf/source-position?token=${encodeURIComponent(joinStatus.token)}`,
      {
        method: "POST",
        body: { page: 1, x: 10, y: 20, version: 1, artifactId: "compile-concurrent" }
      }
    );
    await slowStarted;

    const heartbeat = waitForWsMessage(guestWs, "heartbeat");
    guestWs.send(JSON.stringify({ type: "heartbeat" }));
    const [state, fastLookup, heartbeatResponse] = await Promise.all([
      request(baseUrl, "/api/state"),
      request(baseUrl, "/api/pdf/source-position", {
        method: "POST",
        body: { page: 1, x: 20, y: 20, version: 1, artifactId: "compile-concurrent" }
      }),
      heartbeat
    ]);
    assert.equal(state.project.mainFile, "main.tex");
    assert.deepEqual(fastLookup, { ok: true, path: "main.tex", line: 2, column: 0 });
    assert.equal(heartbeatResponse.type, "heartbeat");

    releaseSlow({
      ok: true,
      stdout: `Input:${path.join(tempRoot, "main.tex")}\nLine: 1\nColumn: 0\n`,
      stderr: ""
    });
    const slowResponse = await slowLookup;
    assert.equal(slowResponse.response.statusCode, 200);
    assert.deepEqual(slowResponse.payload, { ok: true, path: "main.tex", line: 1, column: 0 });
  } finally {
    releaseSlow?.({ ok: false, timedOut: true, stdout: "", stderr: "" });
    guestWs?.close();
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("SyncTeX lookup saturation returns busy and recovers a slot after runner rejection", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-synctex-saturation-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Saturation\\end{document}", "utf8");
  const pdfPath = path.join(tempRoot, "main.pdf");
  const synctexPath = path.join(tempRoot, "main.synctex.gz");
  fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"));
  fs.writeFileSync(synctexPath, "synctex", "utf8");
  const held = new Map();
  let runnerCalls = 0;
  const mappedOutput = (line) => ({
    ok: true,
    stdout: `Input:${path.join(tempRoot, "main.tex")}\nLine: ${line}\nColumn: 0\n`,
    stderr: ""
  });
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    synctexCommand: "fake-synctex",
    synctexProcessRunner: ({ x }) => {
      runnerCalls += 1;
      if (x >= 5) return Promise.resolve(mappedOutput(x));
      return new Promise((resolve, reject) => held.set(x, { resolve, reject }));
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  app.state.compile = {
    ...app.state.compile,
    status: "success",
    mode: "pdf",
    pdfPath,
    synctexPath,
    sourceMapAvailable: true,
    version: 1,
    artifactId: "compile-saturation"
  };
  const baseUrl = hostBaseUrl(app, port);
  const lookup = (x) => request(baseUrl, "/api/pdf/source-position", {
    method: "POST",
    body: { page: 1, x, y: 20, version: 1, artifactId: "compile-saturation" }
  });
  let active = [];

  try {
    active = [1, 2, 3, 4].map(lookup);
    await waitForValue(() => held.size === 4);

    const saturated = await lookup(5);
    assert.deepEqual(saturated, {
      ok: false,
      state: "busy",
      retryable: true,
      reason: "The host is already handling several PDF source lookups. Try this click again in a moment."
    });
    assert.equal(runnerCalls, 4);

    held.get(1).reject(new Error("simulated runner rejection"));
    assert.deepEqual(await active[0], {
      ok: false,
      state: "unavailable",
      reason: "SyncTeX lookup failed on the host."
    });

    const recovered = await lookup(6);
    assert.deepEqual(recovered, { ok: true, path: "main.tex", line: 6, column: 0 });
    assert.equal(runnerCalls, 5);

    [2, 3, 4].forEach((x) => held.get(x).resolve(mappedOutput(x)));
    const remaining = await Promise.all(active.slice(1));
    assert.deepEqual(remaining.map((result) => result.line), [2, 3, 4]);
  } finally {
    for (const [x, pending] of held) pending.resolve(mappedOutput(x));
    await Promise.allSettled(active);
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reports update availability and platform downloads to the host", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-update-test-"));
  fs.writeFileSync(path.join(tempRoot, "main.tex"), "\\documentclass{article}\\begin{document}Update\\end{document}", "utf8");

  const app = createLocalLeafServer({
    port: 0,
    projectRoot: tempRoot,
    autoStartTunnel: false,
    fetchLatestRelease: async () => ({
      tag_name: "v99.0.0",
      html_url: "https://github.com/sethwhenton/localleaf/releases/tag/v99.0.0",
      assets: [
        {
          name: "LocalLeaf-Host-Setup.exe",
          browser_download_url: "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-Setup.exe"
        },
        {
          name: "LocalLeaf-Host-mac-arm64.dmg",
          browser_download_url: "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-mac-arm64.dmg"
        },
        {
          name: "LocalLeaf-Host-mac-x64.dmg",
          browser_download_url: "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-mac-x64.dmg"
        }
      ]
    })
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const info = await request(baseUrl, "/api/update/latest");
    assert.equal(info.latestVersion, "99.0.0");
    assert.equal(info.updateAvailable, true);
    assert.equal(info.releaseUrl, "https://github.com/sethwhenton/localleaf/releases/tag/v99.0.0");
    assert.equal(info.siteUrl, "https://sethwhenton.github.io/localleaf/");
    assert.equal(info.downloads.windows, "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-Setup.exe");
    assert.equal(info.downloads.macArm64, "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-mac-arm64.dmg");
    assert.equal(info.downloads.macX64, "https://github.com/sethwhenton/localleaf/releases/download/v99.0.0/LocalLeaf-Host-mac-x64.dmg");
    if (process.platform === "win32") {
      assert.equal(info.assetName, "LocalLeaf-Host-Setup.exe");
      assert.equal(info.downloadUrl, info.downloads.windows);
    } else if (process.platform === "darwin" && process.arch === "arm64") {
      assert.equal(info.assetName, "LocalLeaf-Host-mac-arm64.dmg");
      assert.equal(info.downloadUrl, info.downloads.macArm64);
    } else if (process.platform === "darwin") {
      assert.equal(info.assetName, "LocalLeaf-Host-mac-x64.dmg");
      assert.equal(info.downloadUrl, info.downloads.macX64);
    }

    const denied = await fetch(buildTestUrl(baseUrl, "/api/update/latest"));
    assert.equal(denied.status, 403);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("keeps the current project and last-good PDF when opening the next project cannot finish enumeration", async () => {
  const initialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-project-switch-current-"));
  const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-project-switch-next-"));
  const artifactRoots = [];
  fs.writeFileSync(path.join(initialRoot, "main.tex"), "current project", "utf8");
  fs.writeFileSync(path.join(nextRoot, "main.tex"), "next project", "utf8");
  const app = createLocalLeafServer({
    port: 0,
    projectRoot: initialRoot,
    autoStartTunnel: false,
    compileProject: async () => {
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-project-switch-artifact-"));
      const pdfPath = path.join(artifactRoot, "main.pdf");
      artifactRoots.push(artifactRoot);
      fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\ncurrent-project-last-good\n%%EOF\n", "utf8"));
      return {
        ok: true,
        engine: "test compiler",
        mode: "pdf",
        logs: [],
        previewHtml: "<p>current project</p>",
        pdfPath,
        synctexPath: null,
        artifactRoot,
        sourceSnapshotRoot: null,
        stale: false
      };
    }
  });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const compiled = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    const before = await request(baseUrl, "/api/state");
    assert.equal(compiled.status, "success");
    assert.ok(compiled.artifactId);

    const originalReaddirSync = fs.readdirSync;
    let nextRootEnumerations = 0;
    let opened;
    try {
      fs.readdirSync = function readdirSyncWithNextProjectFailure(directory, ...args) {
        if (path.resolve(String(directory)) === path.resolve(nextRoot)) {
          nextRootEnumerations += 1;
          if (nextRootEnumerations === 2) {
            const error = new Error("simulated next-project enumeration failure");
            error.code = "EIO";
            throw error;
          }
        }
        return originalReaddirSync.call(this, directory, ...args);
      };
      opened = await rawRequest(baseUrl, "/api/project/open", {
        method: "POST",
        body: { path: nextRoot }
      });
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(opened.response.status, 500);
    assert.match(opened.payload.error, /enumeration failure/);
    assert.equal(nextRootEnumerations, 2);

    const after = await request(baseUrl, "/api/state");
    assert.equal(after.project.id, before.project.id);
    assert.equal(after.project.root, initialRoot);
    assert.equal(after.compile.status, "success");
    assert.equal(after.compile.artifactId, compiled.artifactId);
    assert.equal(after.compile.lastSuccessfulAt, compiled.lastSuccessfulAt);
    assert.equal(after.compile.pdfAvailable, true);
    assert.equal(fs.existsSync(artifactRoots[0]), true);

    const pdf = await binaryRequest(baseUrl, "/api/pdf");
    assert.equal(pdf.response.status, 200);
    assert.match(pdf.buffer.toString("utf8"), /current-project-last-good/);
  } finally {
    await app.stop();
    fs.rmSync(initialRoot, { recursive: true, force: true });
    fs.rmSync(nextRoot, { recursive: true, force: true });
    for (const artifactRoot of artifactRoots) {
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  }
});

test("creates new projects from the bundled starter template", async () => {
  const previousProjectsDir = process.env.LOCALLEAF_PROJECTS_DIR;
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-new-projects-"));
  const initialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-initial-"));
  process.env.LOCALLEAF_PROJECTS_DIR = projectsRoot;
  fs.writeFileSync(path.join(initialRoot, "main.tex"), "\\documentclass{article}\\begin{document}Initial\\end{document}", "utf8");

  const app = createLocalLeafServer({ port: 0, projectRoot: initialRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const created = await request(baseUrl, "/api/project/new", { method: "POST", body: {} });
    assert.equal(created.project.name, "LocalLeaf Project");
    assert.equal(created.project.mainFile, "main.tex");
    assert.match(created.project.root, /LocalLeaf Project$/);
    assert.ok(created.project.files.some((file) => file.path === "main.tex" && file.type === "text"));
    assert.ok(created.project.files.some((file) => file.path === "references.bib" && file.type === "text"));
    assert.ok(created.project.files.some((file) => file.path === "assets/localleaf-icon.png" && file.type === "image"));
    assert.match(fs.readFileSync(path.join(created.project.root, "main.tex"), "utf8"), /\\includegraphics\[width=0\.28\\linewidth\]\{assets\/localleaf-icon\.png\}/);

    const second = await request(baseUrl, "/api/project/new", { method: "POST", body: {} });
    assert.equal(second.project.name, "LocalLeaf Project 2");
  } finally {
    await app.stop();
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(initialRoot, { recursive: true, force: true });
    if (previousProjectsDir === undefined) {
      delete process.env.LOCALLEAF_PROJECTS_DIR;
    } else {
      process.env.LOCALLEAF_PROJECTS_DIR = previousProjectsDir;
    }
  }
});

test("imports loose files as a new project", async () => {
  const previousProjectsDir = process.env.LOCALLEAF_PROJECTS_DIR;
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-loose-imports-"));
  const initialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-initial-"));
  process.env.LOCALLEAF_PROJECTS_DIR = projectsRoot;
  fs.writeFileSync(path.join(initialRoot, "main.tex"), "\\documentclass{article}\\begin{document}Initial\\end{document}", "utf8");

  const app = createLocalLeafServer({ port: 0, projectRoot: initialRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    const mainTex = "\\documentclass{article}\\begin{document}Loose Import\\cite{leaf}\\end{document}";
    const imported = await rawRequest(baseUrl, "/api/project/import-files", {
      method: "POST",
      rawBody: JSON.stringify({
        projectName: "loose-report",
        files: [
          {
            path: "main.tex",
            name: "main.tex",
            contentBase64: Buffer.from(mainTex, "utf8").toString("base64")
          },
          {
            path: "references.bib",
            name: "references.bib",
            contentBase64: Buffer.from("@article{leaf,title={LocalLeaf}}", "utf8").toString("base64")
          },
          {
            path: "images/tiny.png",
            name: "tiny.png",
            contentBase64: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8p4VwAAAABJRU5ErkJggg==",
              "base64"
            ).toString("base64")
          }
        ]
      })
    });

    assert.equal(imported.response.status, 200);
    assert.equal(imported.payload.project.name, "loose-report");
    assert.equal(imported.payload.project.mainFile, "main.tex");
    assert.ok(imported.payload.project.files.some((file) => file.path === "main.tex" && file.type === "text"));
    assert.ok(imported.payload.project.files.some((file) => file.path === "references.bib" && file.type === "text"));
    assert.ok(imported.payload.project.files.some((file) => file.path === "images/tiny.png" && file.type === "image"));
    assert.match(fs.readFileSync(path.join(imported.payload.project.root, "main.tex"), "utf8"), /Loose Import/);

    const duplicate = await rawRequest(baseUrl, "/api/project/import-files", {
      method: "POST",
      rawBody: JSON.stringify({
        files: [
          { path: "main.tex", contentBase64: Buffer.from(mainTex, "utf8").toString("base64") },
          { path: "MAIN.tex", contentBase64: Buffer.from(mainTex, "utf8").toString("base64") }
        ]
      })
    });
    assert.equal(duplicate.response.status, 400);
  } finally {
    await app.stop();
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(initialRoot, { recursive: true, force: true });
    if (previousProjectsDir === undefined) {
      delete process.env.LOCALLEAF_PROJECTS_DIR;
    } else {
      process.env.LOCALLEAF_PROJECTS_DIR = previousProjectsDir;
    }
  }
});

test("supports the host, join, edit, compile, chat, import, stop flow", async () => {
  const previousForcePreview = process.env.LOCALLEAF_FORCE_PREVIEW;
  const previousProjectsDir = process.env.LOCALLEAF_PROJECTS_DIR;
  process.env.LOCALLEAF_FORCE_PREVIEW = "1";
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-projects-"));
  process.env.LOCALLEAF_PROJECTS_DIR = projectsRoot;
  const fixtureRoot = path.resolve(__dirname, "../samples/thesis");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-test-"));
  fs.cpSync(fixtureRoot, tempRoot, { recursive: true });

  const app = createLocalLeafServer({ port: 0, projectRoot: tempRoot, autoStartTunnel: false });
  app.server.listen(0);
  await once(app.server, "listening");
  const port = app.server.address().port;
  app.state.port = port;
  const baseUrl = hostBaseUrl(app, port);

  try {
    let state = await request(baseUrl, "/api/state");
    assert.equal(state.project.mainFile, "main.tex");

    state = await request(baseUrl, "/api/session/start", { method: "POST", body: {} });
    assert.equal(state.session.status, "live");
    assert.match(state.session.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const publicStateResult = await publicTunnelRequest(baseUrl, "/api/state");
    const publicState = publicStateResult.payload;
    assert.equal(publicState.project.root, undefined);
    assert.equal(publicState.project.files, undefined);
    assert.equal(publicState.session.code, undefined);
    assert.equal(publicState.compiler.command, undefined);

    const blockedFile = await publicTunnelRequest(baseUrl, "/api/file?path=main.tex");
    assert.equal(blockedFile.response.statusCode, 403);

    const join = await request(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Ben", code: state.session.code }
    });
    assert.equal(join.status, "pending");

    const approved = await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.requestId, role: "maintainer" }
    });
    assert.equal(approved.ok, true);

    const joinStatus = await request(baseUrl, `/api/join-status?id=${encodeURIComponent(join.requestId)}`);
    assert.ok(joinStatus.token);

    const guestStopAttempt = await publicTunnelRequest(
      baseUrl,
      `/api/session/stop?token=${encodeURIComponent(joinStatus.token)}`,
      { method: "POST" }
    );
    assert.equal(guestStopAttempt.response.statusCode, 403);
    state = await request(baseUrl, "/api/state");
    assert.equal(state.session.status, "live");

    const suggestions = await request(baseUrl, `/api/editor/suggestions?token=${encodeURIComponent(joinStatus.token)}`);
    assert.ok(Array.isArray(suggestions.labels));
    assert.ok(Array.isArray(suggestions.citations));
    assert.ok(Array.isArray(suggestions.macros));
    assert.ok(Array.isArray(suggestions.environments));

    const hostWs = new WebSocket(`ws://localhost:${port}/collab?host=${encodeURIComponent(app.state.hostToken)}`);
    const guestWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(joinStatus.token)}`);
    const hostSync = waitForWsMessage(hostWs, "sync_state");
    const guestSync = waitForWsMessage(guestWs, "sync_state");
    await Promise.all([waitForWsOpen(hostWs), waitForWsOpen(guestWs)]);
    await Promise.all([hostSync, guestSync]);
    hostWs.send(JSON.stringify({ type: "open_file", filePath: "main.tex" }));
    const guestPresence = waitForWsMessage(guestWs, "presence_update", (payload) => payload.userId === "host");
    await waitForWsMessage(hostWs, "file_opened", (payload) => payload.filePath === "main.tex");
    assert.equal((await guestPresence).filePath, "main.tex");

    guestWs.send(JSON.stringify({ type: "open_file", filePath: "main.tex" }));
    await waitForWsMessage(guestWs, "file_opened", (payload) => payload.filePath === "main.tex");
    const sharedText = fs.readFileSync(path.join(tempRoot, "main.tex"), "utf8").replace("A LocalLeaf Starter Project", "A Shared Thesis");
    const guestUpdate = waitForWsMessage(guestWs, "file_updated", (payload) => payload.filePath === "main.tex");
    hostWs.send(JSON.stringify({ type: "edit", filePath: "main.tex", newText: sharedText }));
    assert.match((await guestUpdate).newText, /A Shared Thesis/);
    assert.match(fs.readFileSync(path.join(tempRoot, "main.tex"), "utf8"), /A Shared Thesis/);
    const savedNotice = waitForWsMessage(hostWs, "file_saved", (payload) => payload.filePath === "main.tex");
    guestWs.send(JSON.stringify({ type: "save", filePath: "main.tex" }));
    assert.equal((await savedNotice).filePath, "main.tex");
    const guestOfflinePresence = waitForWsMessage(
      hostWs,
      "presence_update",
      (payload) => payload.name === "Ben" && !payload.presence?.some((item) => item.name === "Ben")
    );
    guestWs.close();
    const offline = await guestOfflinePresence;
    assert.ok(offline.presence.some((item) => item.name !== "Ben"));
    hostWs.close();

    const file = await request(baseUrl, "/api/file?path=main.tex");
    assert.match(file.content, /A Shared Thesis/);

    await request(baseUrl, "/api/file", {
      method: "POST",
      body: {
        path: "main.tex",
        content: file.content.replace("A Shared Thesis", "A LocalLeaf Thesis"),
        user: "Ben"
      }
    });
    const diskContent = fs.readFileSync(path.join(tempRoot, "main.tex"), "utf8");
    assert.match(diskContent, /A LocalLeaf Thesis/);

    const compiled = await request(baseUrl, "/api/compile", { method: "POST", body: {} });
    assert.equal(compiled.status, "success");
    assert.ok(compiled.previewHtml.includes("A LocalLeaf Thesis"));

    const chat = await request(baseUrl, "/api/chat", {
      method: "POST",
      headers: { "x-localleaf-token": joinStatus.token },
      body: { author: "Spoofed Name", message: "Real chat message" }
    });
    assert.equal(chat.author, "Ben");
    assert.equal(chat.message, "Real chat message");

    const created = await request(baseUrl, "/api/file/create", {
      method: "POST",
      body: { path: "appendix.tex", content: "\\section{Appendix}\nReal file ops work." }
    });
    assert.equal(created.path, "appendix.tex");

    const renamed = await request(baseUrl, "/api/file/rename", {
      method: "POST",
      body: { from: "appendix.tex", to: "chapters/appendix.tex" }
    });
    assert.equal(renamed.path, "chapters/appendix.tex");

    const renamedFolder = await request(baseUrl, "/api/file/rename", {
      method: "POST",
      body: { from: "chapters", to: "sections" }
    });
    assert.equal(renamedFolder.path, "sections");
    state = await request(baseUrl, "/api/state");
    assert.ok(state.project.files.some((item) => item.path === "sections" && item.type === "directory"));
    assert.ok(state.project.files.some((item) => item.path === "sections/appendix.tex" && item.type === "text"));

    const copiedFile = await request(baseUrl, "/api/file/copy", {
      method: "POST",
      body: { from: "sections/appendix.tex", to: "appendix copy.tex" }
    });
    assert.equal(copiedFile.path, "appendix copy.tex");
    assert.match(fs.readFileSync(path.join(tempRoot, "appendix copy.tex"), "utf8"), /Real file ops work/);

    const copiedFolder = await request(baseUrl, "/api/file/copy", {
      method: "POST",
      body: { from: "sections", to: "sections copy" }
    });
    assert.equal(copiedFolder.path, "sections copy");
    assert.ok(fs.existsSync(path.join(tempRoot, "sections copy", "appendix.tex")));

    const duplicateCopy = await rawRequest(baseUrl, "/api/file/copy", {
      method: "POST",
      body: { from: "sections/appendix.tex", to: "appendix copy.tex" }
    });
    assert.equal(duplicateCopy.response.status, 409);

    const downloadedFile = await binaryRequest(baseUrl, "/api/file/download?path=appendix%20copy.tex");
    assert.equal(downloadedFile.response.status, 200);
    assert.match(downloadedFile.response.headers.get("content-disposition"), /attachment; filename="appendix copy\.tex"/);
    assert.match(downloadedFile.buffer.toString("utf8"), /Real file ops work/);

    const downloadedFolder = await binaryRequest(baseUrl, "/api/file/download?path=sections%20copy");
    assert.equal(downloadedFolder.response.status, 200);
    assert.equal(downloadedFolder.response.headers.get("content-type"), "application/zip");
    assert.ok(downloadedFolder.buffer.length > 100);

    const folder = await request(baseUrl, "/api/folder/create", {
      method: "POST",
      body: { path: "images" }
    });
    assert.equal(folder.path, "images");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8p4VwAAAABJRU5ErkJggg==",
      "base64"
    );
    const uploaded = await rawRequest(baseUrl, "/api/file/upload", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-file-path": "images/proof.png"
      },
      rawBody: png
    });
    assert.equal(uploaded.response.status, 200);
    assert.equal(uploaded.payload.path, "images/proof.png");
    assert.deepEqual(fs.readFileSync(path.join(tempRoot, "images", "proof.png")), png);
    state = await request(baseUrl, "/api/state");
    assert.ok(state.project.files.some((item) => item.path === "images" && item.type === "directory"));
    assert.ok(state.project.files.some((item) => item.path === "images/proof.png" && item.type === "image"));

    const image = await binaryRequest(baseUrl, "/api/asset?path=images%2Fproof.png");
    assert.equal(image.response.status, 200);
    assert.equal(image.response.headers.get("content-type"), "image/png");
    assert.ok(image.buffer.length > 20);

    const windowsPathUpload = await rawRequest(baseUrl, "/api/file/upload", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-file-path": "images\\windows-proof.png"
      },
      rawBody: png
    });
    assert.equal(windowsPathUpload.response.status, 200);
    assert.equal(windowsPathUpload.payload.path, "images/windows-proof.png");
    assert.deepEqual(fs.readFileSync(path.join(tempRoot, "images", "windows-proof.png")), png);
    state = await request(baseUrl, "/api/state");
    assert.ok(state.project.files.some((item) => item.path === "images/windows-proof.png" && item.type === "image"));

    const windowsPathImage = await binaryRequest(baseUrl, "/api/asset?path=images%2Fwindows-proof.png");
    assert.equal(windowsPathImage.response.status, 200);
    assert.equal(windowsPathImage.response.headers.get("content-type"), "image/png");
    assert.ok(windowsPathImage.buffer.length > 20);

    const exportedZip = await publicTunnelBinaryRequest(
      baseUrl,
      `/api/export/zip?token=${encodeURIComponent(joinStatus.token)}`
    );
    assert.equal(exportedZip.response.statusCode, 200);
    assert.equal(exportedZip.response.headers["content-type"], "application/zip");
    assert.match(
      exportedZip.response.headers["content-disposition"],
      /^attachment; filename=".+\.zip"; filename\*=UTF-8''.+\.zip$/
    );
    assert.ok(exportedZip.buffer.length > 100);

    const missingPdf = await binaryRequest(baseUrl, "/api/export/pdf");
    assert.equal(missingPdf.response.status, 404);

    const zipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-zip-source-"));
    fs.writeFileSync(path.join(zipRoot, "main.tex"), "\\documentclass{article}\\begin{document}Zip Project\\end{document}", "utf8");
    const zipPath = path.join(os.tmpdir(), `localleaf-${Date.now()}.zip`);
    const zip = new AdmZip();
    zip.addLocalFile(path.join(zipRoot, "main.tex"));
    zip.writeZip(zipPath);
    const importedWhileLive = await rawRequest(baseUrl, "/api/project/import-zip", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-file-name": "real-latex-project.zip"
      },
      rawBody: fs.readFileSync(zipPath)
    });
    assert.equal(importedWhileLive.response.status, 409);

    const endingWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(joinStatus.token)}`);
    const endingSync = waitForWsMessage(endingWs, "sync_state");
    await waitForWsOpen(endingWs);
    await endingSync;
    const endedNotice = waitForWsMessage(endingWs, "session_ended");

    state = await request(baseUrl, "/api/session/stop", { method: "POST", body: {} });
    assert.equal(state.session.status, "ended");
    assert.equal((await endedNotice).reason, "Host stopped the session.");
    endingWs.close();

    const importedAfterStop = await rawRequest(baseUrl, "/api/project/import-zip", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-file-name": "real-latex-project.zip"
      },
      rawBody: fs.readFileSync(zipPath)
    });
    assert.equal(importedAfterStop.response.status, 200);
    assert.equal(importedAfterStop.payload.project.mainFile, "main.tex");
    fs.rmSync(zipRoot, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });

    const guestZipAfterStop = await publicTunnelBinaryRequest(
      baseUrl,
      `/api/export/zip?token=${encodeURIComponent(joinStatus.token)}`
    );
    assert.equal(guestZipAfterStop.response.statusCode, 403);
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (previousForcePreview === undefined) {
      delete process.env.LOCALLEAF_FORCE_PREVIEW;
    } else {
      process.env.LOCALLEAF_FORCE_PREVIEW = previousForcePreview;
    }
    if (previousProjectsDir === undefined) {
      delete process.env.LOCALLEAF_PROJECTS_DIR;
    } else {
      process.env.LOCALLEAF_PROJECTS_DIR = previousProjectsDir;
    }
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  }
});
