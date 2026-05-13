const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listProjectFiles, resolveProjectPath } = require("./safe-path");

const DEFAULT_CURSOR_MODEL_ID = "composer-2";

function copyProjectToScratch(projectRoot) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-cursor-agent-"));
  const sourceRoot = path.resolve(projectRoot);
  fs.cpSync(sourceRoot, scratchRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source).replace(/\\/g, "/");
      if (!relative) return true;
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

function changedTextFiles(before, scratchRoot) {
  const changes = [];
  for (const [filePath, oldText] of before.entries()) {
    const fullPath = resolveProjectPath(scratchRoot, filePath);
    if (!fs.existsSync(fullPath)) continue;
    const newText = fs.readFileSync(fullPath, "utf8");
    if (newText !== oldText) {
      changes.push({ path: filePath, oldText, newText });
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
    context.currentPath ? `Current file: ${context.currentPath}` : "",
    selectedText ? `Selected text:\n${selectedText}` : "",
    compileLogs ? `Recent compile logs:\n${compileLogs}` : "",
    `User request:\n${message}`
  ].filter(Boolean).join("\n\n");
}

async function runCursorSdkAgent(options = {}) {
  const apiKey = String(options.apiKey || process.env.CURSOR_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Cursor SDK API key is not configured.");
  }
  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey,
    model: { id: options.modelId || DEFAULT_CURSOR_MODEL_ID },
    local: { cwd: options.cwd }
  });
  try {
    const run = await agent.send(options.prompt);
    const parts = [];
    if (run.supports?.("stream")) {
      for await (const event of run.stream()) {
        if (typeof event?.text === "string") parts.push(event.text);
        if (Array.isArray(event?.content)) {
          for (const block of event.content) {
            if (typeof block?.text === "string") parts.push(block.text);
          }
        }
      }
    }
    const result = run.supports?.("wait") ? await run.wait() : null;
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
