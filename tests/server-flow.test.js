const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const AdmZip = require("adm-zip");
const WebSocket = require("ws");
const { createLocalLeafServer } = require("../src/server/index");

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

test("races tunnel providers and keeps the first verified link", async () => {
  const fixtureRoot = path.resolve(__dirname, "../samples/thesis");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-race-test-"));
  fs.cpSync(fixtureRoot, tempRoot, { recursive: true });
  const checkedUrls = [];
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
    checkPublicTunnel: async (url) => {
      checkedUrls.push(url);
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
  } finally {
    await app.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
    assert.equal(publicState.project.root, "Stored on host computer");
    assert.deepEqual(publicState.project.files, []);

    const blockedFile = await publicTunnelRequest(baseUrl, "/api/file?path=main.tex");
    assert.equal(blockedFile.response.statusCode, 403);

    const join = await request(baseUrl, "/api/join", {
      method: "POST",
      body: { name: "Ben", code: state.session.code }
    });
    assert.equal(join.status, "pending");

    const approved = await request(baseUrl, "/api/join/approve", {
      method: "POST",
      body: { requestId: join.requestId, role: "editor" }
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
    hostWs.close();
    guestWs.close();

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
    const imported = await rawRequest(baseUrl, "/api/project/import-zip", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-file-name": "real-latex-project.zip"
      },
      rawBody: fs.readFileSync(zipPath)
    });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.payload.project.mainFile, "main.tex");
    fs.rmSync(zipRoot, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });

    const endingWs = new WebSocket(`ws://localhost:${port}/collab?token=${encodeURIComponent(joinStatus.token)}`);
    const endingSync = waitForWsMessage(endingWs, "sync_state");
    await waitForWsOpen(endingWs);
    await endingSync;
    const endedNotice = waitForWsMessage(endingWs, "session_ended");

    state = await request(baseUrl, "/api/session/stop", { method: "POST", body: {} });
    assert.equal(state.session.status, "ended");
    assert.equal((await endedNotice).reason, "Host stopped the session.");
    endingWs.close();

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
