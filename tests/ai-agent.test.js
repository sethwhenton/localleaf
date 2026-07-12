const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
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

async function waitUntil(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function configureFakeHostedProvider(baseUrl) {
  await request(baseUrl, "/api/ai/providers/save", {
    method: "POST",
    body: {
      id: "session-test-provider",
      name: "Session test provider",
      type: "openai-compatible",
      baseUrl: "https://provider.invalid/v1",
      modelId: "session-test-model",
      models: [{ id: "session-test-model", name: "Session test model", contextWindowTokens: 32768 }],
      activate: true
    }
  });
}

function fakeHostedResult(payload) {
  return {
    provider: { id: "session-test-provider", name: "Session test provider" },
    modelId: "session-test-model",
    content: JSON.stringify(payload)
  };
}

test("exposes host-only AI model state and model storage plumbing", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-model-project-"));
  const modelParent = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-models-"));
  let nextParent = "";
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot, {
    modelRoot: modelParent,
    aiDownloadImpl: async ({ targetPath, model, onProgress }) => {
      onProgress({ progress: 50, bytesReceived: 5, totalBytes: 10 });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, "fake-gguf", "utf8");
      return { bytes: 9, filePath: targetPath, modelId: model.id };
    }
  });

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
    assert.match(downloading.models.find((model) => model.id === "qwen35-08b-light").status, /downloading|installed/);
  } finally {
    await app.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modelParent, { recursive: true, force: true });
    if (nextParent) fs.rmSync(nextParent, { recursive: true, force: true });
  }
});

test("keeps local model prompts within a bounded context budget", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-local-context-project-"));
  const modelParent = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-local-context-models-"));
  fs.writeFileSync(
    path.join(projectRoot, "main.tex"),
    `\\documentclass{article}\n\\begin{document}\n${"Current file context. ".repeat(2500)}\n\\end{document}\n`,
    "utf8"
  );
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(
      path.join(projectRoot, `chapter-${index}.tex`),
      `\\section{Chapter ${index}}\n${`Project context ${index}. `.repeat(1800)}\n`,
      "utf8"
    );
  }
  const { app, baseUrl } = await startApp(projectRoot, {
    modelRoot: modelParent,
    aiDownloadImpl: async ({ targetPath, model }) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, "fake-gguf", "utf8");
      return { bytes: 9, filePath: targetPath, modelId: model.id };
    }
  });

  try {
    await request(baseUrl, "/api/ai/models/download", {
      method: "POST",
      body: { modelId: "qwen35-08b-light" }
    });
    await waitUntil(() => app.state.ai.models.publicState().models.find((model) => model.id === "qwen35-08b-light")?.installed);
    await request(baseUrl, "/api/ai/models/activate", {
      method: "POST",
      body: { modelId: "qwen35-08b-light" }
    });

    let capturedPrompt = "";
    const richReply = "## Project summary\n\nThe draft uses **one** main file and a short article body.";
    app.state.ai.models.askLocalModel = async (messages, options = {}) => {
      capturedPrompt = messages.map((message) => String(message.content || "")).join("\n\n");
      assert.equal(options.maxTokens, 1000);
      return {
        provider: { id: "localleaf-local", name: "LocalLeaf Local", type: "local-llama-cpp" },
        modelId: "qwen35-08b-light",
        content: JSON.stringify({ reply: richReply, edits: [] })
      };
    };

    const result = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "what is this project about?",
        aiProviderId: "localleaf-local"
      }
    });

    assert.equal(result.reply, richReply);
    assert.ok(capturedPrompt.length < 42000, `prompt was too large: ${capturedPrompt.length}`);
    assert.match(capturedPrompt, /LocalLeaf truncated this file for context|LocalLeaf omitted the middle/u);
    assert.match(capturedPrompt, /LocalLeaf safe Markdown/u);
    assert.match(capturedPrompt, /Do not emit raw HTML, Markdown images, or links that are not credential-free HTTPS URLs\./u);
    assert.match(capturedPrompt, /preserve the requested voice, facts, quotations, citations, and meaning/u);
    assert.match(capturedPrompt, /never add commentary outside the JSON object/u);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(modelParent, { recursive: true, force: true });
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
      body: { path: "main.tex", message: "rewrite this section", selectedText: "We utilize this draft." }
    });
    assert.match(
      message.reply,
      /^I prepared an edit to `main\.tex` for review, rewriting common verbose phrases without changing project structure\./u
    );
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

test("scopes deterministic rewrites to the exact selected prose", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-selected-rewrite-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const selectedText = "We utilize this paragraph in order to improve clarity.";
  const originalText = [
    "\\documentclass{article}",
    "\\begin{document}",
    "A cited quote says ``We utilize this claim in order to explain it.'' \\cite{doe2024}",
    "\\begin{verbatim}",
    "utilize in order to",
    "\\end{verbatim}",
    selectedText,
    "\\end{document}",
    ""
  ].join("\n");
  fs.writeFileSync(mainPath, originalText);
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "rewrite the selected text",
        selectedText
      }
    });

    assert.equal(message.proposals.length, 1);
    assert.equal(
      message.proposals[0].newText,
      originalText.replace(selectedText, "We use this paragraph to improve clarity.")
    );
    assert.match(message.proposals[0].newText, /``We utilize this claim in order to explain it\.'' \\cite\{doe2024\}/u);
    assert.match(message.proposals[0].newText, /\\begin\{verbatim\}\nutilize in order to\n\\end\{verbatim\}/u);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("refuses to manage an AI proposal while another project is active", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-proposal-origin-project-"));
  const nextProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-proposal-next-project-"));
  const originalPath = path.join(projectRoot, "main.tex");
  const nextPath = path.join(nextProjectRoot, "main.tex");
  fs.writeFileSync(originalPath, "\\documentclass{article}\n\\begin{document}\nOrigin title.\n\\end{document}\n", "utf8");
  fs.writeFileSync(nextPath, "\\documentclass{article}\n\\begin{document}\nOrigin title.\n\\end{document}\n", "utf8");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const prepared = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "origin-project-run",
        path: "main.tex",
        message: "change from Origin title to Updated title"
      }
    });
    const proposal = prepared.proposals[0];
    assert.equal(proposal.status, "proposed");

    await request(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: nextProjectRoot }
    });

    for (const endpoint of [
      "/api/agent/approval/approve",
      "/api/agent/proposal/apply",
      "/api/agent/approval/reject"
    ]) {
      const blocked = await rawRequest(baseUrl, endpoint, {
        method: "POST",
        body: { proposalId: proposal.id }
      });
      assert.equal(blocked.response.status, 409, endpoint);
      assert.equal(blocked.payload.code, "AI_PROPOSAL_PROJECT_MISMATCH", endpoint);
    }
    assert.match(fs.readFileSync(nextPath, "utf8"), /Origin title/u);

    await request(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: projectRoot }
    });
    const applied = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(applied.proposal.status, "applied");
    assert.match(fs.readFileSync(originalPath, "utf8"), /Updated title/u);

    await request(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: nextProjectRoot }
    });
    const blockedRevert = await rawRequest(baseUrl, "/api/agent/proposal/revert", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(blockedRevert.response.status, 409);
    assert.equal(blockedRevert.payload.code, "AI_PROPOSAL_PROJECT_MISMATCH");

    const blockedRunRevert = await rawRequest(baseUrl, "/api/agent/run/revert", {
      method: "POST",
      body: { runId: "origin-project-run" }
    });
    assert.equal(blockedRunRevert.response.status, 409);
    assert.equal(blockedRunRevert.payload.code, "AI_PROPOSAL_PROJECT_MISMATCH");
    assert.match(fs.readFileSync(originalPath, "utf8"), /Updated title/u);
    assert.match(fs.readFileSync(nextPath, "utf8"), /Origin title/u);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(nextProjectRoot, { recursive: true, force: true });
  }
});

test("keeps delayed hosted full-file proposals based on the pre-provider file snapshot", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-hosted-snapshot-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalText = "\\documentclass{article}\n\\title{Original}\n\\begin{document}\nDraft body.\n\\end{document}\n";
  const concurrentText = originalText.replace("Draft body.", "Draft body edited while AI was thinking.");
  const providerText = originalText.replace("\\title{Original}", "\\title{Provider title}");
  fs.writeFileSync(mainPath, originalText, "utf8");
  const { app, baseUrl } = await startApp(projectRoot);
  const providerStarted = deferred();
  const providerReply = deferred();

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerStarted.resolve();
      return providerReply.promise;
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const pending = rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "hosted-snapshot-run",
        clientMessageId: "hosted-snapshot-user",
        sessionId: sessions.currentSessionId,
        path: "main.tex",
        message: "rewrite the title",
        aiPermissions: { askBeforeEdits: false, yoloMode: true }
      }
    });
    await providerStarted.promise;
    await request(baseUrl, "/api/file", {
      method: "POST",
      body: { path: "main.tex", content: concurrentText, user: "Editor" }
    });
    providerReply.resolve({
      provider: { id: "session-test-provider", name: "Session test provider" },
      modelId: "session-test-model",
      content: JSON.stringify({
        reply: "I rewrote the title.",
        edits: [{ path: "main.tex", newText: providerText }]
      })
    });

    const response = await pending;
    assert.equal(response.response.status, 200);
    const proposal = response.payload.proposals[0];
    assert.equal(proposal.approvalRequired, false);
    const stale = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.proposal.status, "stale");
    assert.equal(fs.readFileSync(mainPath, "utf8"), concurrentText);
  } finally {
    providerReply.resolve({ content: "{}" });
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("preserves quoted spans inside a deterministic rewrite selection", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-quoted-rewrite-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const selectedText = "We utilize this introduction in order to frame ``We utilize the archived claim in order to explain it.'' alongside “We utilize the cited source in order to quote it.” and \"We utilize the interview line in order to retain it.\"";
  const expectedSelection = "We use this introduction to frame ``We utilize the archived claim in order to explain it.'' alongside “We utilize the cited source in order to quote it.” and \"We utilize the interview line in order to retain it.\"";
  const originalText = `\\documentclass{article}\n\\begin{document}\n${selectedText}\n\\end{document}\n`;
  fs.writeFileSync(mainPath, originalText);
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "rewrite the selected text",
        selectedText
      }
    });

    assert.equal(message.proposals.length, 1);
    assert.equal(message.proposals[0].newText, originalText.replace(selectedText, expectedSelection));
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("does not invent a deterministic rewrite without an exact selection", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-unscoped-rewrite-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalText = "\\documentclass{article}\n\\begin{document}\nWe utilize this cited draft. \\cite{doe2024}\n\\end{document}\n";
  fs.writeFileSync(mainPath, originalText);
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "rewrite the selected text",
        selectedText: "This selection is not present in the file."
      }
    });

    assert.equal(message.proposals.length, 0);
    assert.match(message.reply, /select the exact text|exact replacement/i);
    assert.doesNotMatch(message.reply, /prepared an edit.+for review/i);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalText);
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
      body: { path: "main.tex", message: "rewrite this section", selectedText: "We utilize this draft." }
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

test("normalizes direct fallback proposal summaries before returning approval cards", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-direct-summary-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nOld <b>label</b>\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "change from Old <b>label</b> to New label"
      }
    });

    assert.equal(message.proposals.length, 1);
    assert.equal(message.proposals[0].summary, 'Replace "Old label" with "New label".');
    assert.doesNotMatch(message.proposals[0].summary, /<\/?b>/u);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("scopes PDF annotation replacements to the mapped source block", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-agent-annotation-project-"));
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
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "replace aim with objective",
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
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].summary, /annotated PDF selection/);
    assert.match(message.proposals[0].newText, /The objective of this lab/);
    assert.match(message.proposals[0].newText, /The aim of the final section/);
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
        selectedText: "We utilize this draft.",
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
      body: { path: "main.tex", message: "rewrite this section", selectedText: "We utilize this draft." }
    });
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get("content-type") || "", /application\/x-ndjson/);
    const eventTypes = stream.events.map((event) => event.type);
    const requiredTypes = ["run_started", "context_snapshot", "proposal_created", "approval_required", "run_done"];
    let lastIndex = -1;
    for (const type of requiredTypes) {
      const nextIndex = eventTypes.indexOf(type, lastIndex + 1);
      assert.notEqual(nextIndex, -1, `missing ${type} event`);
      lastIndex = nextIndex;
    }
    const proposalEvent = stream.events.find((event) => event.type === "proposal_created");
    const startedEvent = stream.events.find((event) => event.type === "run_started");
    const contextEvent = stream.events.find((event) => event.type === "context_snapshot");
    const doneEvent = stream.events.find((event) => event.type === "run_done");
    assert.ok(startedEvent.sessionId);
    assert.equal(contextEvent.sessionId, startedEvent.sessionId);
    assert.equal(contextEvent.contextUsage.status, "not_applicable");
    assert.equal(doneEvent.sessionId, startedEvent.sessionId);
    assert.equal(doneEvent.result.contextUsage.status, "not_applicable");
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

test("keeps a delayed response with its origin session after switching", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-origin-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  const providerStarted = deferred();
  const providerReply = deferred();

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerStarted.resolve();
      return providerReply.promise;
    };
    const initial = await request(baseUrl, "/api/ai/sessions");
    const originSessionId = initial.currentSessionId;
    const pendingResponse = request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "origin-run",
        clientMessageId: "origin-user-message",
        sessionId: originSessionId,
        path: "main.tex",
        message: "What does this project contain?"
      }
    });
    await providerStarted.promise;

    const created = await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { projectKey: initial.projectKey }
    });
    const activeSessionId = created.currentSessionId;
    assert.notEqual(activeSessionId, originSessionId);

    providerReply.resolve({
      provider: { id: "session-test-provider", name: "Session test provider" },
      modelId: "session-test-model",
      content: JSON.stringify({ reply: "It contains a small LaTeX article.", edits: [] }),
      usage: { inputTokens: 700, outputTokens: 20, totalTokens: 720, source: "provider_reported" },
      contextWindowTokens: 32768,
      windowSource: "provider_model_config"
    });
    const result = await pendingResponse;
    assert.equal(result.sessionId, originSessionId);
    assert.equal(result.runId, "origin-run");
    assert.equal(result.assistantMessage.message, "It contains a small LaTeX article.");

    const sessions = await request(baseUrl, "/api/ai/sessions");
    assert.equal(sessions.currentSessionId, activeSessionId);
    assert.equal(sessions.activeSession.messages.length, 0);
    const originSummary = sessions.sessions.find((session) => session.id === originSessionId);
    assert.equal(originSummary.unread, true);
    assert.equal(originSummary.messageCount, 2);
    assert.equal(originSummary.lastContextUsage.usage.totalTokens, 720);

    const origin = await request(baseUrl, "/api/ai/sessions/activate", {
      method: "POST",
      body: { projectKey: initial.projectKey, sessionId: originSessionId }
    });
    assert.deepEqual(origin.activeSession.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(origin.activeSession.unread, false);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("blocks project replacement while an AI response is running", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-project-switch-origin-"));
  const nextProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-project-switch-next-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nOrigin\n\\end{document}\n");
  fs.writeFileSync(path.join(nextProjectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nNext\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  const providerStarted = deferred();
  const providerReply = deferred();

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerStarted.resolve();
      return providerReply.promise;
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const runId = "project-switch-run";
    const pending = rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { runId, sessionId: sessions.currentSessionId, path: "main.tex", message: "Wait" }
    });
    await providerStarted.promise;

    const switched = await rawRequest(baseUrl, "/api/project/open", {
      method: "POST",
      body: { path: nextProjectRoot }
    });
    assert.equal(switched.response.status, 409);
    assert.equal(switched.payload.code, "AI_RUN_BUSY");
    assert.equal(app.state.project.root, projectRoot);

    await request(baseUrl, "/api/agent/run/cancel", {
      method: "POST",
      body: { runId, sessionId: sessions.currentSessionId }
    });
    providerReply.resolve({ content: JSON.stringify({ reply: "Late", edits: [] }) });
    const cancelled = await pending;
    assert.equal(cancelled.payload.code, "AI_RUN_CANCELLED");
  } finally {
    providerReply.resolve({ content: "{}" });
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(nextProjectRoot, { recursive: true, force: true });
  }
});

test("rejects an invalid session before invoking the provider", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-rejection-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      return {
        provider: { id: "session-test-provider", name: "Session test provider" },
        modelId: "session-test-model",
        content: JSON.stringify({ reply: "Unexpected", edits: [] })
      };
    };
    const result = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { sessionId: "missing-session", path: "main.tex", message: "Hello" }
    });
    assert.equal(result.response.status, 404);
    assert.equal(result.payload.code, "AI_SESSION_NOT_FOUND");
    assert.equal(providerCalls, 0);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cancels a running response without appending a late assistant message", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-cancel-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  const providerStarted = deferred();
  const providerReply = deferred();

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async (_messages, options = {}) => {
      providerStarted.resolve(options.signal);
      return providerReply.promise;
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const sessionId = sessions.currentSessionId;
    const pendingResponse = rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "cancel-run",
        clientMessageId: "cancel-user-message",
        sessionId,
        path: "main.tex",
        message: "Wait for me"
      }
    });
    const signal = await providerStarted.promise;

    const cancelled = await request(baseUrl, "/api/agent/run/cancel", {
      method: "POST",
      body: { runId: "cancel-run", sessionId }
    });
    assert.equal(cancelled.activeSession.runStatus, "idle");
    assert.equal(signal.aborted, true);

    providerReply.resolve({
      provider: { id: "session-test-provider", name: "Session test provider" },
      modelId: "session-test-model",
      content: JSON.stringify({
        reply: "This reply arrived too late.",
        edits: [{
          path: "main.tex",
          replacements: [{ find: "Hello", replace: "Too late" }]
        }]
      })
    });
    const response = await pendingResponse;
    assert.equal(response.response.status, 409);
    assert.equal(response.payload.code, "AI_RUN_CANCELLED");
    const after = await request(baseUrl, "/api/ai/sessions");
    assert.deepEqual(after.activeSession.messages.map((message) => message.role), ["user"]);
    assert.equal(app.state.ai.proposals.size, 0);
  } finally {
    providerReply.resolve({ content: "{}" });
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("replays a completed run ID without invoking the provider or appending twice", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-idempotent-project-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      return {
        provider: { id: "session-test-provider", name: "Session test provider" },
        modelId: "session-test-model",
        content: JSON.stringify({ reply: providerCalls === 1 ? "Only once." : "A later run.", edits: [] }),
        usage: providerCalls === 1
          ? { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
          : { inputTokens: 20, outputTokens: 4, totalTokens: 24 }
      };
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const body = {
      runId: "same-run",
      clientMessageId: "same-user-message",
      sessionId: sessions.currentSessionId,
      path: "main.tex",
      message: "Reply once"
    };
    const first = await request(baseUrl, "/api/agent/message", { method: "POST", body });
    await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: { ...body, runId: "later-run", clientMessageId: "later-user-message", message: "Reply later" }
    });
    const replay = await request(baseUrl, "/api/agent/message", { method: "POST", body });

    assert.equal(providerCalls, 2);
    assert.equal(first.assistantMessage.message, "Only once.");
    assert.equal(replay.assistantMessage.message, "Only once.");
    assert.equal(replay.replayed, true);
    assert.equal(replay.contextUsage.usage.totalTokens, 12);
    const after = await request(baseUrl, "/api/ai/sessions");
    assert.equal(after.activeSession.messages.filter((message) => message.runId === "same-run").length, 2);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("replays the oldest retained run after its transcript messages have been capped", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-ledger-replay-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      return {
        provider: { id: "session-test-provider", name: "Session test provider" },
        modelId: "session-test-model",
        content: JSON.stringify({ reply: `Reply ${providerCalls}`, edits: [] }),
        usage: { inputTokens: providerCalls, outputTokens: 1, totalTokens: providerCalls + 1 }
      };
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const sessionId = sessions.currentSessionId;
    const firstBody = {
      runId: "retained-run-0",
      clientMessageId: "retained-user-0",
      sessionId,
      path: "main.tex",
      message: "Retained request 0"
    };

    for (let index = 0; index < 61; index += 1) {
      await request(baseUrl, "/api/agent/message", {
        method: "POST",
        body: index === 0 ? firstBody : {
          runId: `retained-run-${index}`,
          clientMessageId: `retained-user-${index}`,
          sessionId,
          path: "main.tex",
          message: `Retained request ${index}`
        }
      });
    }

    const capped = await request(baseUrl, "/api/ai/sessions");
    assert.equal(capped.activeSession.messages.length, 120);
    assert.equal(capped.activeSession.messages.some((item) => item.runId === firstBody.runId), false);

    const replay = await request(baseUrl, "/api/agent/message", { method: "POST", body: firstBody });
    assert.equal(providerCalls, 61);
    assert.equal(replay.replayed, true);
    assert.equal(replay.sessionId, sessionId);
    assert.equal(replay.assistantMessage.message, "Reply 1");
    assert.equal(replay.contextUsage.usage.totalTokens, 2);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("streams a completed-run replay with its origin session and lifecycle order", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-stream-replay-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      return {
        provider: { id: "session-test-provider", name: "Session test provider" },
        modelId: "session-test-model",
        content: JSON.stringify({ reply: "Replay me once.", edits: [] }),
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
      };
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const originSessionId = sessions.currentSessionId;
    const body = {
      runId: "stream-replay-run",
      clientMessageId: "stream-replay-user",
      sessionId: originSessionId,
      path: "main.tex",
      message: "Stream this replay"
    };
    await request(baseUrl, "/api/agent/message", { method: "POST", body });
    await request(baseUrl, "/api/ai/sessions/create", {
      method: "POST",
      body: { projectKey: sessions.projectKey }
    });

    const stream = await ndjsonRequest(baseUrl, "/api/agent/run", { method: "POST", body });
    const eventTypes = stream.events.map((event) => event.type);
    const startedIndex = eventTypes.indexOf("run_started");
    const contextIndex = eventTypes.indexOf("context_snapshot");
    const deltaIndex = eventTypes.indexOf("assistant_delta");
    const doneIndex = eventTypes.indexOf("run_done");
    assert.ok(startedIndex >= 0);
    assert.ok(contextIndex > startedIndex);
    assert.ok(deltaIndex > contextIndex);
    assert.ok(doneIndex > deltaIndex);
    assert.equal(providerCalls, 1);
    for (const event of stream.events.filter((event) => ["run_started", "context_snapshot", "assistant_delta", "run_done"].includes(event.type))) {
      assert.equal(event.sessionId, originSessionId);
    }
    const done = stream.events[doneIndex];
    assert.equal(done.result.replayed, true);
    assert.equal(done.result.sessionId, originSessionId);
    assert.equal(done.result.assistantMessage.message, "Replay me once.");
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects legacy session imports for a mismatched project key", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-import-project-key-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const before = await request(baseUrl, "/api/ai/sessions");
    const rejected = await rawRequest(baseUrl, "/api/ai/sessions/import-legacy", {
      method: "POST",
      body: {
        projectKey: "different-project",
        sessions: [{ id: "wrong-project-session", title: "Wrong project", messages: [] }],
        currentSessionId: "wrong-project-session"
      }
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.payload.code, "AI_SESSION_PROJECT_MISMATCH");

    const after = await request(baseUrl, "/api/ai/sessions");
    assert.equal(after.projectKey, before.projectKey);
    assert.equal(after.sessions.some((session) => session.id === "wrong-project-session"), false);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects a concurrent duplicate run ID before a second provider call", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-session-duplicate-running-"));
  fs.writeFileSync(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);
  const providerStarted = deferred();
  const providerReply = deferred();
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      providerStarted.resolve();
      return providerReply.promise;
    };
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const body = {
      runId: "duplicate-running-run",
      clientMessageId: "duplicate-running-user",
      sessionId: sessions.currentSessionId,
      path: "main.tex",
      message: "Wait once"
    };
    const first = rawRequest(baseUrl, "/api/agent/message", { method: "POST", body });
    await providerStarted.promise;
    const duplicate = await rawRequest(baseUrl, "/api/agent/message", { method: "POST", body });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.payload.code, "AI_RUN_BUSY");
    assert.equal(providerCalls, 1);

    await request(baseUrl, "/api/agent/run/cancel", {
      method: "POST",
      body: { runId: body.runId, sessionId: body.sessionId }
    });
    providerReply.resolve({ content: JSON.stringify({ reply: "Late", edits: [] }) });
    assert.equal((await first).payload.code, "AI_RUN_CANCELLED");
  } finally {
    providerReply.resolve({ content: "{}" });
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("preserves run metadata and safely reverts applied AI proposals", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-revert-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nAlpha title.\n\\end{document}\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    const runId = "run-revert-test";
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId,
        message: "change from Alpha title to Beta title",
        path: "main.tex",
        aiPermissions: { askBeforeEdits: true }
      }
    });
    const proposal = message.proposals[0];
    assert.equal(proposal.runId, runId);
    assert.ok(proposal.newHash);
    assert.ok(Number.isInteger(proposal.focus.start));
    assert.ok(Number.isInteger(proposal.focus.end));

    const applied = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(applied.proposal.status, "applied");
    assert.equal(applied.proposal.newHash, proposal.newHash);
    assert.match(fs.readFileSync(mainPath, "utf8"), /Beta title/);

    const reverted = await request(baseUrl, "/api/agent/proposal/revert", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(reverted.proposal.status, "reverted");
    assert.match(fs.readFileSync(mainPath, "utf8"), /Alpha title/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("undoes AI runs all-or-nothing and refuses stale revert targets", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-run-undo-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const sectionPath = path.join(projectRoot, "section.tex");
  fs.writeFileSync(mainPath, "\\documentclass{article}\n\\begin{document}\nAlpha\n\\input{section}\n\\end{document}\n");
  fs.writeFileSync(sectionPath, "Gamma\n");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => ({
      provider: { id: "session-test-provider", name: "Session test provider" },
      modelId: "session-test-model",
      content: JSON.stringify({
        reply: "Prepared the coordinated edits.",
        edits: [
          { path: "main.tex", replacements: [{ find: "Alpha", replace: "Beta" }] },
          { path: "section.tex", replacements: [{ find: "Gamma", replace: "Delta" }] }
        ]
      })
    });
    const prepareRun = (runId) => request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId,
        clientMessageId: `${runId}-user`,
        message: "Apply the coordinated edits to both files",
        path: "main.tex",
        aiPermissions: { askBeforeEdits: true, multiFileEdits: true }
      }
    });
    const runId = "run-undo-test";
    const prepared = await prepareRun(runId);
    assert.equal(prepared.proposals.length, 2);
    for (const proposal of prepared.proposals) {
      await request(baseUrl, "/api/agent/approval/approve", {
        method: "POST",
        body: { proposalId: proposal.id }
      });
    }

    const undone = await request(baseUrl, "/api/agent/run/revert", {
      method: "POST",
      body: { runId }
    });
    assert.equal(undone.proposals.length, 2);
    assert.match(fs.readFileSync(mainPath, "utf8"), /\bAlpha\b/);
    assert.match(fs.readFileSync(sectionPath, "utf8"), /\bGamma\b/);

    const staleRunId = "run-stale-undo-test";
    const stalePrepared = await prepareRun(staleRunId);
    assert.equal(stalePrepared.proposals.length, 2);
    for (const proposal of stalePrepared.proposals) {
      await request(baseUrl, "/api/agent/approval/approve", {
        method: "POST",
        body: { proposalId: proposal.id }
      });
    }
    fs.writeFileSync(mainPath, fs.readFileSync(mainPath, "utf8").replace("Beta", "Manual"));
    const stale = await rawRequest(baseUrl, "/api/agent/run/revert", {
      method: "POST",
      body: { runId: staleRunId }
    });
    assert.equal(stale.response.status, 409);
    assert.match(fs.readFileSync(mainPath, "utf8"), /\bManual\b/);
    assert.match(fs.readFileSync(sectionPath, "utf8"), /\bDelta\b/);

    fs.writeFileSync(mainPath, fs.readFileSync(mainPath, "utf8").replace("Manual", "Alpha"));
    fs.writeFileSync(sectionPath, fs.readFileSync(sectionPath, "utf8").replace("Delta", "Gamma"));
    const failureRunId = "run-write-failure-undo-test";
    const failurePrepared = await prepareRun(failureRunId);
    assert.equal(failurePrepared.proposals.length, 2);
    for (const proposal of failurePrepared.proposals) {
      await request(baseUrl, "/api/agent/approval/approve", {
        method: "POST",
        body: { proposalId: proposal.id }
      });
    }
    assert.match(fs.readFileSync(mainPath, "utf8"), /\bBeta\b/);
    assert.match(fs.readFileSync(sectionPath, "utf8"), /\bDelta\b/);

    const originalWriteFileSync = fs.writeFileSync;
    let injectedFailure = false;
    fs.writeFileSync = (filePath, data, ...args) => {
      if (!injectedFailure && path.resolve(filePath) === path.resolve(sectionPath) && String(data) === "Gamma\n") {
        injectedFailure = true;
        throw new Error("Injected second-file write failure");
      }
      return originalWriteFileSync(filePath, data, ...args);
    };
    let failedUndo;
    try {
      failedUndo = await rawRequest(baseUrl, "/api/agent/run/revert", {
        method: "POST",
        body: { runId: failureRunId }
      });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.equal(injectedFailure, true);
    assert.equal(failedUndo.response.status, 500);
    assert.match(failedUndo.payload.error, /restored every file/i);
    assert.match(fs.readFileSync(mainPath, "utf8"), /\bBeta\b/);
    assert.match(fs.readFileSync(sectionPath, "utf8"), /\bDelta\b/);

    const retriedUndo = await request(baseUrl, "/api/agent/run/revert", {
      method: "POST",
      body: { runId: failureRunId }
    });
    assert.equal(retriedUndo.proposals.length, 2);
    assert.match(fs.readFileSync(mainPath, "utf8"), /\bAlpha\b/);
    assert.match(fs.readFileSync(sectionPath, "utf8"), /\bGamma\b/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("creates proposals from Cursor SDK scratch workspace diffs without mutating live files first", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-cursor-agent-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalText = "\\documentclass{article}\n\\title{ML}\n\\begin{document}\n\\maketitle\n\\end{document}\n";
  let cursorPrompt = "";
  fs.writeFileSync(mainPath, originalText);
  const { app, baseUrl } = await startApp(projectRoot, {
    cursorAgentRunner: async ({ cwd, prompt }) => {
      cursorPrompt = prompt;
      fs.writeFileSync(
        path.join(cwd, "main.tex"),
        originalText.replace("\\title{ML}", "\\title{Machine Learning}"),
        "utf8"
      );
      return { reply: "## Edit summary\n\nI expanded the title and kept the document structure unchanged." };
    }
  });

  try {
    await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "cursor",
        templateId: "cursor",
        name: "Cursor",
        type: "cursor-sdk",
        baseUrl: "cursor-sdk://local",
        apiKey: "cursor-test-key",
        models: [{ id: "composer-2", name: "Composer 2" }],
        activate: true
      }
    });
    const message = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "hello\nchange the title from ML to Machine Learning in the first page",
        aiProviderId: "cursor",
        aiModelId: "composer-2"
      }
    });

    assert.equal(message.provider.id, "cursor");
    assert.equal(message.proposals.length, 1);
    assert.match(message.proposals[0].newText, /\\title\{Machine Learning\}/);
    assert.match(message.reply, /^I prepared an edit to `main\.tex` for review\./u);
    assert.match(message.reply, /## Edit summary/u);
    assert.match(cursorPrompt, /LocalLeaf safe Markdown/u);
    assert.match(cursorPrompt, /preserve the requested voice, facts, quotations, citations, and meaning/u);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalText);

    await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: message.proposals[0].id }
    });
    assert.match(fs.readFileSync(mainPath, "utf8"), /\\title\{Machine Learning\}/);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("keeps delayed Cursor proposals based on the scratch workspace source snapshot", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-cursor-snapshot-project-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalText = "\\documentclass{article}\n\\title{Original}\n\\begin{document}\nDraft body.\n\\end{document}\n";
  const concurrentText = originalText.replace("Draft body.", "Draft body edited while Cursor was thinking.");
  const cursorText = originalText.replace("\\title{Original}", "\\title{Cursor title}");
  const cursorStarted = deferred();
  const cursorReply = deferred();
  fs.writeFileSync(mainPath, originalText, "utf8");
  const { app, baseUrl } = await startApp(projectRoot, {
    cursorAgentRunner: async ({ cwd }) => {
      cursorStarted.resolve(cwd);
      await cursorReply.promise;
      fs.writeFileSync(path.join(cwd, "main.tex"), cursorText, "utf8");
      return { reply: "Cursor rewrote the title." };
    }
  });

  try {
    await request(baseUrl, "/api/ai/providers/save", {
      method: "POST",
      body: {
        id: "cursor",
        templateId: "cursor",
        name: "Cursor",
        type: "cursor-sdk",
        baseUrl: "cursor-sdk://local",
        apiKey: "cursor-test-key",
        models: [{ id: "composer-2", name: "Composer 2" }],
        activate: true
      }
    });
    const sessions = await request(baseUrl, "/api/ai/sessions");
    const pending = rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "cursor-snapshot-run",
        clientMessageId: "cursor-snapshot-user",
        sessionId: sessions.currentSessionId,
        path: "main.tex",
        message: "rewrite the title",
        aiProviderId: "cursor",
        aiModelId: "composer-2",
        aiPermissions: { askBeforeEdits: false, yoloMode: true }
      }
    });
    await cursorStarted.promise;
    await request(baseUrl, "/api/file", {
      method: "POST",
      body: { path: "main.tex", content: concurrentText, user: "Editor" }
    });
    cursorReply.resolve();

    const response = await pending;
    assert.equal(response.response.status, 200);
    const proposal = response.payload.proposals[0];
    assert.equal(proposal.approvalRequired, false);
    const stale = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.proposal.status, "stale");
    assert.equal(fs.readFileSync(mainPath, "utf8"), concurrentText);
  } finally {
    cursorReply.resolve();
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("keeps AI-created files behind host approval even in YOLO mode and supports exact revert", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-lifecycle-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const createdPath = path.join(projectRoot, "chapters", "method.tex");
  const originalMain = "\\documentclass{article}\n\\begin{document}\nOriginal body.\n\\end{document}\n";
  const createdContent = "\\section{Method}\nExact provider content.\n";
  fs.writeFileSync(mainPath, originalMain, "utf8");
  const { app, baseUrl } = await startApp(projectRoot);
  let capturedPrompt = "";

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async (messages) => {
      capturedPrompt = messages.map((message) => String(message.content || "")).join("\n");
      return fakeHostedResult({
        reply: "I prepared the requested chapter file.",
        edits: [],
        creates: [{
          path: "chapters/method.tex",
          content: createdContent,
          summary: "Create the method chapter."
        }]
      });
    };

    const prepared = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "create-lifecycle-run",
        path: "main.tex",
        message: "Create a new chapters/method.tex file for the method section",
        aiPermissions: {
          askBeforeEdits: false,
          yoloMode: true,
          fileManagement: true
        }
      }
    });

    assert.equal(prepared.proposals.length, 1);
    const proposal = prepared.proposals[0];
    assert.equal(proposal.operation, "create");
    assert.equal(proposal.path, "chapters/method.tex");
    assert.equal(proposal.newText, createdContent);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.approvalRequired, true);
    assert.equal(fs.existsSync(createdPath), false);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
    assert.match(capturedPrompt, /"creates":\[\{"path":"relative\/project\/new-file\.tex"/u);
    assert.match(capturedPrompt, /new project-relative path/u);

    const applied = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(applied.proposal.operation, "create");
    assert.equal(applied.proposal.status, "applied");
    assert.equal(fs.readFileSync(createdPath, "utf8"), createdContent);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);

    const reverted = await request(baseUrl, "/api/agent/proposal/revert", {
      method: "POST",
      body: { proposalId: proposal.id }
    });
    assert.equal(reverted.proposal.operation, "create");
    assert.equal(reverted.proposal.status, "reverted");
    assert.equal(fs.existsSync(createdPath), false);

    const state = await request(baseUrl, "/api/state");
    const historyRecord = state.ai.proposals.find((item) => item.id === proposal.id);
    assert.equal(historyRecord.operation, "create");
    assert.equal(historyRecord.status, "reverted");
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("treats an exclusive-create race as stale without overwriting the winning file", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-race-"));
  const targetPath = path.join(projectRoot, "chapters", "race.tex");
  fs.writeFileSync(
    path.join(projectRoot, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nRace test.\n\\end{document}\n",
    "utf8"
  );
  const { app, baseUrl } = await startApp(projectRoot);
  const providerContent = "Provider must not overwrite this race.\n";
  const winningContent = "Created by the winning writer.\n";

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => fakeHostedResult({
      reply: "I prepared the race file.",
      edits: [],
      creates: [{ path: "chapters/race.tex", content: providerContent }]
    });
    const prepared = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "Create a new chapters/race.tex file",
        aiPermissions: { fileManagement: true }
      }
    });
    const proposal = prepared.proposals[0];
    assert.equal(fs.existsSync(targetPath), false);

    const originalOpenSync = fs.openSync;
    let injectedRace = false;
    fs.openSync = (filePath, flags, ...rest) => {
      const isExclusiveTarget = path.resolve(String(filePath)) === path.resolve(targetPath)
        && flags === "wx";
      if (!injectedRace && isExclusiveTarget) {
        injectedRace = true;
        const winningDescriptor = originalOpenSync(targetPath, "wx");
        try {
          const winningBuffer = Buffer.from(winningContent, "utf8");
          fs.writeSync(winningDescriptor, winningBuffer, 0, winningBuffer.length, null);
          fs.fsyncSync(winningDescriptor);
        } finally {
          fs.closeSync(winningDescriptor);
        }
      }
      return originalOpenSync(filePath, flags, ...rest);
    };
    let raced;
    try {
      raced = await rawRequest(baseUrl, "/api/agent/approval/approve", {
        method: "POST",
        body: { proposalId: proposal.id }
      });
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(injectedRace, true);
    assert.equal(raced.response.status, 409);
    assert.equal(raced.payload.proposal.status, "stale");
    assert.equal(fs.readFileSync(targetPath, "utf8"), winningContent);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("rejects unsafe hosted file creations without falling back to an edit of main.tex", async (t) => {
  const oversizedContent = "x".repeat((256 * 1024) + 1);
  const cases = [
    {
      name: "path traversal",
      creates: [{ path: "../escape.tex", content: "escaped" }],
      error: /traversal|outside the project/i
    },
    {
      name: "Windows absolute path",
      creates: [{ path: "C:\\outside\\chapter.tex", content: "absolute" }],
      error: /absolute|invalid path|project-relative/i
    },
    {
      name: "POSIX absolute path",
      creates: [{ path: "/outside/chapter.tex", content: "absolute" }],
      error: /absolute|invalid path|project-relative/i
    },
    {
      name: "UNC absolute path",
      creates: [{ path: "\\\\server\\share\\chapter.tex", content: "absolute" }],
      error: /absolute|invalid path|project-relative/i
    },
    {
      name: "hidden path",
      creates: [{ path: ".private/chapter.tex", content: "hidden" }],
      error: /visible project-relative path/i
    },
    {
      name: "unsupported extension",
      creates: [{ path: "figures/generated.png", content: "not really a PNG" }],
      error: /text-based LaTeX source/i
    },
    {
      name: "null byte in path",
      creates: [{ path: "chapters/bad\0.tex", content: "bad path" }],
      error: /absolute|invalid path/i
    },
    {
      name: "null byte in content",
      creates: [{ path: "chapters/null.tex", content: "before\0after" }],
      error: /null bytes/i
    },
    {
      name: "oversized content",
      creates: [{ path: "chapters/large.tex", content: oversizedContent }],
      error: /256 KB or smaller/i
    },
    {
      name: "duplicate create targets",
      creates: [
        { path: "chapters/duplicate.tex", content: "first" },
        { path: "chapters/duplicate.tex", content: "second" }
      ],
      error: /same new file more than once/i
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-invalid-"));
      const mainPath = path.join(projectRoot, "main.tex");
      const originalMain = "\\documentclass{article}\n\\begin{document}\nDo not edit me.\n\\end{document}\n";
      fs.writeFileSync(mainPath, originalMain, "utf8");
      const { app, baseUrl } = await startApp(projectRoot);

      try {
        await configureFakeHostedProvider(baseUrl);
        app.state.ai.models.askActiveProvider = async () => fakeHostedResult({
          reply: "I prepared files.",
          edits: [],
          creates: scenario.creates
        });
        const rejected = await rawRequest(baseUrl, "/api/agent/message", {
          method: "POST",
          body: {
            runId: `invalid-create-${scenario.name.replace(/\s+/gu, "-")}`,
            path: "main.tex",
            message: "Create a new project file",
            aiPermissions: { fileManagement: true, multiFileEdits: true }
          }
        });

        assert.equal(rejected.response.status, 400);
        assert.match(rejected.payload.error, scenario.error);
        assert.equal(app.state.ai.proposals.size, 0);
        assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
        assert.deepEqual(
          fs.readdirSync(projectRoot).filter((name) => name !== "main.tex" && !name.startsWith(".")),
          []
        );
      } finally {
        await app.stop();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }
});

test("refuses hosted create output when File management is off", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-permission-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const originalMain = "\\documentclass{article}\n\\begin{document}\nPermission test.\n\\end{document}\n";
  fs.writeFileSync(mainPath, originalMain, "utf8");
  const { app, baseUrl } = await startApp(projectRoot);
  let providerCalls = 0;

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => {
      providerCalls += 1;
      return fakeHostedResult({
        reply: "I prepared an appendix.",
        edits: [],
        creates: [{ path: "appendix.tex", content: "\\section{Appendix}\n" }]
      });
    };

    const blockedRequest = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "Create a new appendix.tex file",
        aiPermissions: { fileManagement: false }
      }
    });
    assert.equal(blockedRequest.response.status, 400);
    assert.match(blockedRequest.payload.error, /AI permission|Create, rename, move, and delete/i);
    assert.equal(providerCalls, 0);

    const blockedProviderOutput = await rawRequest(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        path: "main.tex",
        message: "Prepare the appendix support source",
        aiPermissions: { fileManagement: false }
      }
    });
    assert.equal(blockedProviderOutput.response.status, 400);
    assert.match(blockedProviderOutput.payload.error, /File management is off/i);
    assert.equal(providerCalls, 1);
    assert.equal(app.state.ai.proposals.size, 0);
    assert.equal(fs.existsSync(path.join(projectRoot, "appendix.tex")), false);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("undoes a mixed hosted create-and-edit run as one project change", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-mixed-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const resultsPath = path.join(projectRoot, "chapters", "results.tex");
  const discussionPath = path.join(projectRoot, "chapters", "discussion.tex");
  const originalMain = "\\documentclass{article}\n\\begin{document}\nOriginal body.\n\\end{document}\n";
  const resultsContent = "\\section{Results}\nMeasured result.\n";
  const discussionContent = "\\section{Discussion}\nInterpretation.\n";
  fs.writeFileSync(mainPath, originalMain, "utf8");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => fakeHostedResult({
      reply: "I prepared the new chapters and wired them into the document.",
      creates: [
        { path: "chapters/results.tex", content: resultsContent },
        { path: "chapters/discussion.tex", content: discussionContent }
      ],
      edits: [{
        path: "main.tex",
        replacements: [{
          find: "Original body.",
          replace: "Updated body.\\input{chapters/results}\\input{chapters/discussion}"
        }]
      }]
    });
    const runId = "mixed-create-edit-run";
    const prepared = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId,
        path: "main.tex",
        message: "Create a new chapter file and update main.tex to include it",
        aiPermissions: {
          fileManagement: true,
          multiFileEdits: true,
          askBeforeEdits: false,
          yoloMode: true
        }
      }
    });

    assert.equal(prepared.proposals.length, 3);
    assert.deepEqual(new Set(prepared.proposals.map((proposal) => proposal.operation)), new Set(["create", "edit"]));
    assert.equal(prepared.proposals.every((proposal) => proposal.approvalRequired === true), true);
    const sessionState = await request(baseUrl, "/api/ai/sessions");
    const persistedAssistant = sessionState.activeSession.messages.find((message) => message.runId === runId && message.role === "assistant");
    assert.ok(persistedAssistant);
    assert.equal(persistedAssistant.proposals.every((proposal) => proposal.approvalRequired === true), true);
    const editProposal = prepared.proposals.find((proposal) => proposal.operation === "edit");
    const createProposals = prepared.proposals
      .filter((proposal) => proposal.operation === "create")
      .sort((left, right) => left.path.localeCompare(right.path));
    assert.ok(editProposal);
    assert.equal(createProposals.length, 2);
    assert.equal(fs.existsSync(resultsPath), false);
    assert.equal(fs.existsSync(discussionPath), false);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);

    const blockedBeforeCreates = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: editProposal.id }
    });
    assert.equal(blockedBeforeCreates.response.status, 409);
    assert.equal(blockedBeforeCreates.payload.code, "AI_CREATE_DEPENDENCY_PENDING");
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);

    const firstCreate = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: createProposals[0].id }
    });
    assert.equal(firstCreate.proposal.status, "applied");
    const blockedAfterOneCreate = await rawRequest(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: editProposal.id }
    });
    assert.equal(blockedAfterOneCreate.response.status, 409);
    assert.equal(blockedAfterOneCreate.payload.code, "AI_CREATE_DEPENDENCY_PENDING");
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);

    const secondCreate = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: createProposals[1].id }
    });
    assert.equal(secondCreate.proposal.status, "applied");
    const appliedEdit = await request(baseUrl, "/api/agent/approval/approve", {
      method: "POST",
      body: { proposalId: editProposal.id }
    });
    assert.equal(appliedEdit.proposal.status, "applied");
    assert.equal(fs.readFileSync(resultsPath, "utf8"), resultsContent);
    assert.equal(fs.readFileSync(discussionPath, "utf8"), discussionContent);
    assert.match(
      fs.readFileSync(mainPath, "utf8"),
      /Updated body\.\\input\{chapters\/results\}\\input\{chapters\/discussion\}/u
    );

    const blockedCreateRevert = await rawRequest(baseUrl, "/api/agent/proposal/revert", {
      method: "POST",
      body: { proposalId: createProposals[0].id }
    });
    assert.equal(blockedCreateRevert.response.status, 409);
    assert.equal(blockedCreateRevert.payload.code, "AI_CREATE_DEPENDENTS_APPLIED");
    assert.equal(fs.existsSync(path.join(projectRoot, createProposals[0].path)), true);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, createProposals[0].path), "utf8"),
      createProposals[0].path === "chapters/results.tex" ? resultsContent : discussionContent
    );

    const undone = await request(baseUrl, "/api/agent/run/revert", {
      method: "POST",
      body: { runId }
    });
    assert.equal(undone.proposals.length, 3);
    assert.equal(undone.proposals.every((proposal) => proposal.status === "reverted"), true);
    assert.equal(fs.existsSync(resultsPath), false);
    assert.equal(fs.existsSync(discussionPath), false);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("refuses a dependent edit when its same-run created file was manually deleted or changed", async (t) => {
  const scenarios = [
    { name: "deleted", action: "delete" },
    { name: "changed", action: "modify" }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `localleaf-ai-create-dependency-${scenario.name}-`));
      const mainPath = path.join(projectRoot, "main.tex");
      const dependencyPath = path.join(projectRoot, "chapters", "dependency.tex");
      const originalMain = "\\documentclass{article}\n\\begin{document}\nOriginal dependency body.\n\\end{document}\n";
      const createdContent = "\\section{Dependency}\nProvider content.\n";
      const manualContent = "\\section{Dependency}\nManually changed content.\n";
      fs.writeFileSync(mainPath, originalMain, "utf8");
      const { app, baseUrl } = await startApp(projectRoot);

      try {
        await configureFakeHostedProvider(baseUrl);
        app.state.ai.models.askActiveProvider = async () => fakeHostedResult({
          reply: "I prepared a dependency file and its include edit.",
          creates: [{ path: "chapters/dependency.tex", content: createdContent }],
          edits: [{
            path: "main.tex",
            replacements: [{
              find: "Original dependency body.",
              replace: "Updated dependency body.\\input{chapters/dependency}"
            }]
          }]
        });
        const runId = `dependency-stale-${scenario.name}`;
        const prepared = await request(baseUrl, "/api/agent/message", {
          method: "POST",
          body: {
            runId,
            path: "main.tex",
            message: "Create a new dependency file and update main.tex to include it",
            aiPermissions: {
              fileManagement: true,
              multiFileEdits: true,
              askBeforeEdits: true
            }
          }
        });
        assert.equal(prepared.proposals.length, 2);
        const createProposal = prepared.proposals.find((proposal) => proposal.operation === "create");
        const editProposal = prepared.proposals.find((proposal) => proposal.operation === "edit");
        assert.ok(createProposal);
        assert.ok(editProposal);

        const created = await request(baseUrl, "/api/agent/approval/approve", {
          method: "POST",
          body: { proposalId: createProposal.id }
        });
        assert.equal(created.proposal.status, "applied");
        assert.equal(fs.readFileSync(dependencyPath, "utf8"), createdContent);

        if (scenario.action === "delete") {
          await request(baseUrl, "/api/file/delete", {
            method: "POST",
            body: { path: "chapters/dependency.tex" }
          });
          assert.equal(fs.existsSync(dependencyPath), false);
        } else {
          await request(baseUrl, "/api/file", {
            method: "POST",
            body: {
              path: "chapters/dependency.tex",
              content: manualContent,
              user: "Host"
            }
          });
          assert.equal(fs.readFileSync(dependencyPath, "utf8"), manualContent);
        }

        const stale = await rawRequest(baseUrl, "/api/agent/approval/approve", {
          method: "POST",
          body: { proposalId: editProposal.id }
        });
        assert.equal(stale.response.status, 409);
        assert.equal(stale.payload.code, "AI_CREATE_DEPENDENCY_STALE");
        assert.equal(stale.payload.proposal.status, "proposed");
        assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
        if (scenario.action === "delete") assert.equal(fs.existsSync(dependencyPath), false);
        else assert.equal(fs.readFileSync(dependencyPath, "utf8"), manualContent);
      } finally {
        await app.stop();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }
});

test("keeps both an exact replacement and hosted creates from the same multi-file request", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-ai-create-exact-mixed-"));
  const mainPath = path.join(projectRoot, "main.tex");
  const appendixPath = path.join(projectRoot, "appendix.tex");
  const originalMain = "\\documentclass{article}\n\\begin{document}\nAlpha title\n\\end{document}\n";
  const appendixContent = "\\section{Appendix}\nSupporting material.\n";
  fs.writeFileSync(mainPath, originalMain, "utf8");
  const { app, baseUrl } = await startApp(projectRoot);

  try {
    await configureFakeHostedProvider(baseUrl);
    app.state.ai.models.askActiveProvider = async () => fakeHostedResult({
      reply: "I prepared the title change and appendix.",
      creates: [{ path: "appendix.tex", content: appendixContent }],
      edits: []
    });
    const prepared = await request(baseUrl, "/api/agent/message", {
      method: "POST",
      body: {
        runId: "exact-replacement-with-create",
        path: "main.tex",
        message: "Change from \"Alpha title\" to \"Beta title\" in main.tex and create a new appendix.tex file",
        aiPermissions: {
          fileManagement: true,
          multiFileEdits: true,
          askBeforeEdits: true
        }
      }
    });

    assert.equal(prepared.proposals.length, 2);
    const createProposal = prepared.proposals.find((proposal) => proposal.operation === "create");
    const editProposal = prepared.proposals.find((proposal) => proposal.operation === "edit");
    assert.ok(createProposal);
    assert.ok(editProposal);
    assert.equal(createProposal.path, "appendix.tex");
    assert.equal(createProposal.newText, appendixContent);
    assert.match(editProposal.newText, /Beta title/u);
    assert.doesNotMatch(editProposal.newText, /Alpha title/u);
    assert.equal(fs.existsSync(appendixPath), false);
    assert.equal(fs.readFileSync(mainPath, "utf8"), originalMain);
  } finally {
    await app.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
