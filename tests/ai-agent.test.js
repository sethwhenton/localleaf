const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
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

async function rawTextRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(buildTestUrl(baseUrl, requestPath), {
    method: options.method || "GET",
    headers: hostHeaders(baseUrl, { "content-type": "application/json", ...(options.headers || {}) }),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { response, text: await response.text() };
}

async function ndjsonRequest(baseUrl, requestPath, options = {}) {
  const result = await rawTextRequest(baseUrl, requestPath, options);
  const events = result.text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, events };
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

test("exposes host-only AI model state and model storage plumbing", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-model-project-"));
  const modelParent = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-models-"));
  let nextParent = "";
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot, { modelRoot: modelParent });

  try {
    const state = await request(baseUrl, "/api/state");
    assert.equal(state.ai.storagePath, path.join(modelParent, "LocalLeafModel"));
    assert.equal(state.ai.permissions.canWriteWithoutApproval, false);
    assert.equal(state.ai.permissions.canDeleteRenameMoveUploadShell, false);
    assert.deepEqual(state.ai.models.map((model) => model.id), ["qwen35-08b-light", "qwen35-2b-recommended"]);
    assert.ok(fs.existsSync(path.join(modelParent, "LocalLeafModel")));

    const publicResult = await rawRequest(new URL(baseUrl).origin, "/api/ai/models");
    assert.equal(publicResult.response.status, 403);

    nextParent = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-models-next-"));
    const storage = await request(baseUrl, "/api/ai/models/storage", {
      method: "POST",
      body: { path: nextParent }
    });
    assert.equal(storage.storagePath, path.join(nextParent, "LocalLeafModel"));

    const downloading = await request(baseUrl, "/api/ai/models/download", {
      method: "POST",
      body: { modelId: "qwen35-08b-light" }
    });
    assert.equal(downloading.models.find((model) => model.id === "qwen35-08b-light").status, "downloading");
  } finally {
    await app.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modelParent, { recursive: true, force: true });
    if (nextParent) fs.rmSync(nextParent, { recursive: true, force: true });
  }
});

test("creates safe AI edit proposals and applies only against the original text hash", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this section" }
    });
    assert.match(message.reply, /Rewrite/);
    assert.equal(message.proposals.length, 1);
    const rewriteProposal = message.proposals[0];
    assert.equal(rewriteProposal.path, "main.tex");
    assert.equal(rewriteProposal.status, "proposed");
    assert.equal(rewriteProposal.approvalRequired, true);
    assert.equal(rewriteProposal.userRequest, "rewrite this section");
    assert.equal(rewriteProposal.provider, null);
    assert.equal(rewriteProposal.modelId, "deterministic-fallback");
    assert.ok(Array.isArray(rewriteProposal.diffHunks));
    assert.ok(rewriteProposal.diffHunks.length > 0);
    assert.ok(rewriteProposal.diffHunks[0].lines.some((line) => line.type === "removed"));
    assert.ok(rewriteProposal.diffHunks[0].lines.some((line) => line.type === "added"));
    assert.match(rewriteProposal.newText, /We use this draft/);

    fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nChanged by editor.\n\\end{document}\n");
    const stale = await rawRequest(baseUrl, "/api/agent/proposal/apply", {
      method: "POST",
      body: { proposalId: rewriteProposal.id }
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.proposal.status, "stale");
    assert.match(fs.readFileSync(mainPath, "utf8"), /Changed by editor/);

    const tableMessage = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "add a table" }
    });
    assert.equal(tableMessage.proposals[0].status, "proposed");
    const applied = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: tableMessage.proposals[0].id }
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.proposal.status, "applied");
    assert.match(fs.readFileSync(mainPath, "utf8"), /\\begin\{tabular\}/);

    const uploadAttempt = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "../outside.tex", message: "delete files" }
    });
    assert.equal(uploadAttempt.response.status, 400);
    assert.match(uploadAttempt.payload.error, /AI permission|permission/i);

    const advancedAllowed = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "delete files",
        aiPermissions: { fileManagement: true }
      }
    });
    assert.match(advancedAllowed.reply, /permission is enabled/i);
    assert.equal(advancedAllowed.proposals.length, 0);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects AI edit proposals without changing file content", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-reject-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalText = "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n";
  fs.writeFileSync(mainPath, originalText);
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this section" }
    });
    const proposal = message.proposals[0];
    assert.equal(proposal.status, "proposed");

    const rejected = await request(baseUrl, "/api/agent/approval/reject", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.proposal.status, "rejected");
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalText);

    const applyRejected = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(applyRejected.response.status, 409);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalText);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("creates exact replacement proposals for update requests", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-replace-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\author{Seth Whenton}\n\\begin{document}\nHi\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { path: "main.tex", message: "in the first page lets update the name from Seth Whenton to Seth William Whenton" }
    });
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].summary, /Replace/);
    assert.match(message.proposals[0].newText, /Seth William Whenton/);

    await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: message.proposals[0].id }
    });
    assert.match(fs.readFileSync(mainPath, "utf8"), /\\author\{Seth William Whenton\}/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("honors AI permission approval mode on proposals", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-permission-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const noConfirm = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "rewrite this section",
        aiPermissions: { askBeforeEdits: false }
      }
    });
    assert.equal(noConfirm.proposals.length, 1);
    assert.equal(noConfirm.proposals[0].approvalRequired, false);

    const yolo = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "add a table",
        aiPermissions: { yoloMode: true }
      }
    });
    assert.equal(yolo.proposals.length, 1);
    assert.equal(yolo.proposals[0].approvalRequired, false);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("streams deterministic fallback proposal lifecycle events from AI agent runs", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-run-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nWe utilize this draft.\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const stream = await ndjsonRequest(baseUrl, "/api/agent/run", {
      method: "POST",
      body: { path: "main.tex", message: "rewrite this section" }
    });
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get("content-type") || "", /application\/x-ndjson/);
    const eventTypes = stream.events.map((event) => event.type);
    const requiredTypes = ["run_started", "proposal_created", "approval_required", "run_done"];
    let lastIndex = -1;
    for (const type of requiredTypes) {
      const nextIndex = eventTypes.indexOf(type, lastIndex + 1);
      assert.notEqual(nextIndex, -1, `missing ${type} event`);
      lastIndex = nextIndex;
    }
    const proposalEvent = stream.events.find((event) => event.type === "proposal_created");
    assert.equal(proposalEvent.proposal.status, "proposed");
    assert.equal(proposalEvent.proposal.approvalRequired, true);
    assert.equal(proposalEvent.proposal.userRequest, "rewrite this section");
    assert.equal(proposalEvent.proposal.modelId, "deterministic-fallback");
    assert.ok(Array.isArray(proposalEvent.proposal.diffHunks));
    assert.match(proposalEvent.proposal.newText, /We use this draft/);
    assert.match(fs.readFileSync(mainPath, "utf8"), /We utilize this draft/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
