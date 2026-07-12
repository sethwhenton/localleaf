const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listProjectFiles, resolveProjectPath } = require("./safe-path");
const { aiResponsePromptGuidance } = require("./ai-response-style");

const DEFAULT_CURSOR_MODEL_ID = "composer-2";

function cursorCancellationError() {
  const error = new Error("Cursor SDK request was cancelled.");
  error.code = "AI_RUN_CANCELLED";
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cursorCancellationError();
}

async function waitWithCancellation(value, signal, cancel) {
  throwIfCancelled(signal);
  if (!signal?.addEventListener) return value;
  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => {
      try {
        cancel?.();
      } finally {
        reject(cursorCancellationError());
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancelCursorRun(run, agent) {
  for (const cancel of [
    () => run?.cancel?.(),
    () => run?.abort?.(),
    () => agent?.close?.()
  ]) {
    try {
      cancel();
    } catch {
      // Continue through every available SDK cancellation hook.
    }
  }
}

function copyProjectToScratch(projectRoot) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-cursor-agent-"));
  const sourceRoot = path.resolve(projectRoot);
  fs.cpSync(sourceRoot, scratchRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replace(/\\/g, "/");
      if (!relative) return true;
      try {
        if (fs.lstatSync(source).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      return !relative.split("/").some((part) => part.startsWith(".") || part === "node_modules");
    }
  });
  return scratchRoot;
}

function snapshotTextFiles(projectRoot) {
  const files = new Map();
  for (const file of listProjectFiles(projectRoot)) {
    if (file.type !== "text") continue;
    const fullPath = resolveProjectPath(projectRoot, file.path);
    files.set(file.path, fs.readFileSync(fullPath, "utf8"));
  }
  return files;
}

function changedTextFiles(before, scratchRoot, options = {}) {
  const changes = [];
  for (const [filePath, oldText] of before.entries()) {
    const fullPath = resolveProjectPath(scratchRoot, filePath);
    if (!fs.existsSync(fullPath)) continue;
    const newText = fs.readFileSync(fullPath, "utf8");
    if (newText !== oldText) {
      changes.push({ path: filePath, oldText, newText, operation: "edit" });
    }
  }
  if (options.includeCreated === true) {
    for (const file of listProjectFiles(scratchRoot)) {
      if (file.type !== "text" || before.has(file.path)) continue;
      const fullPath = resolveProjectPath(scratchRoot, file.path);
      changes.push({
        path: file.path,
        oldText: "",
        newText: fs.readFileSync(fullPath, "utf8"),
        operation: "create"
      });
    }
  }
  return changes;
}

function cursorLatexPrompt(body = {}, context = {}) {
  const message = String(body.message || "").trim();
  const selectedText = String(body.selectedText || "").trim();
  const compileLogs = Array.isArray(body.compileLogs)
    ? body.compileLogs.map((line) => String(line || "")).slice(-160).join("\n")
    : "";
  return [
    "You are LocalLeaf AI inside a LaTeX desktop editor.",
    "Work only inside this temporary project copy. Edit LaTeX source/support text files to satisfy the user request.",
    "Prefer precise edits to existing files. Keep unrelated content unchanged.",
    "You can fix LaTeX compile errors, update titles/authors/sections, create tables, formulas, citations, figures, macros, and clean bibliography text.",
    "Do not edit binary assets. Do not run destructive commands. Do not create files unless the request clearly needs them.",
    context.fileManagementAllowed
      ? "The host allowed file management for this request. You may create a new text-based LaTeX support file when the request clearly requires it; never overwrite an existing file just to simulate creation."
      : "File management is off for this request. Do not create, rename, move, or delete files.",
    aiResponsePromptGuidance({ jsonTransport: false }),
    context.currentPath ? `Current file: ${context.currentPath}` : "",
    selectedText ? `Selected text:\n${selectedText}` : "",
    compileLogs ? `Recent compile logs:\n${compileLogs}` : "",
    `User request:\n${message}`
  ].filter(Boolean).join("\n\n");
}

async function runCursorSdkAgent(options = {}) {
  throwIfCancelled(options.signal);
  const apiKey = String(options.apiKey || process.env.CURSOR_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Cursor SDK API key is not configured.");
  }
  let Agent;
  try {
    ({ Agent } = await import("@cursor/sdk"));
  } catch (error) {
    const missingPackage = error && (error.code === "ERR_MODULE_NOT_FOUND" || /@cursor\/sdk/u.test(String(error.message || "")));
    if (missingPackage) {
      throw new Error("Cursor SDK is not bundled in this LocalLeaf build because its current npm package has vulnerable transitive dependencies. Use an OpenAI-compatible provider or LocalLeaf Local model for now.");
    }
    throw error;
  }
  const agentPromise = Agent.create({
    apiKey,
    model: { id: options.modelId || DEFAULT_CURSOR_MODEL_ID },
    local: { cwd: options.cwd }
  });
  agentPromise.then((createdAgent) => {
    if (options.signal?.aborted) cancelCursorRun(null, createdAgent);
  }, () => {});
  const agent = await waitWithCancellation(agentPromise, options.signal);
  try {
    const run = await waitWithCancellation(agent.send(options.prompt), options.signal, () => cancelCursorRun(null, agent));
    const parts = [];
    if (run.supports?.("stream")) {
      const iterator = run.stream()[Symbol.asyncIterator]();
      while (true) {
        const next = await waitWithCancellation(iterator.next(), options.signal, () => {
          iterator.return?.();
          cancelCursorRun(run, agent);
        });
        if (next.done) break;
        const event = next.value;
        if (typeof event?.text === "string") parts.push(event.text);
        if (Array.isArray(event?.content)) {
          for (const block of event.content) {
            if (typeof block?.text === "string") parts.push(block.text);
          }
        }
      }
    }
    const result = run.supports?.("wait")
      ? await waitWithCancellation(run.wait(), options.signal, () => cancelCursorRun(run, agent))
      : null;
    return {
      runId: run.id,
      agentId: run.agentId,
      reply: parts.join("").trim() || result?.result || "Cursor SDK finished the LaTeX task."
    };
  } finally {
    agent.close?.();
  }
}

module.exports = {
  DEFAULT_CURSOR_MODEL_ID,
  changedTextFiles,
  copyProjectToScratch,
  cursorLatexPrompt,
  runCursorSdkAgent,
  snapshotTextFiles
};
