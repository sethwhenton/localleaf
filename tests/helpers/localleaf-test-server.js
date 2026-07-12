const path = require("node:path");

const { createLocalLeafServer } = require("../../src/server/index");

function createTestLocalLeafServer(options = {}) {
  const suppliedProjectRoot = String(options.projectRoot || "").trim();
  if (!suppliedProjectRoot) throw new Error("A projectRoot is required for a LocalLeaf test server.");
  const projectRoot = path.resolve(suppliedProjectRoot);
  const stateRoot = path.join(projectRoot, ".localleaf-test-state");
  return createLocalLeafServer({
    modelRoot: path.join(stateRoot, "models"),
    aiSessionRoot: path.join(stateRoot, "ai-sessions"),
    aiChangeRoot: path.join(stateRoot, "ai-changes"),
    ...options
  });
}

module.exports = { createTestLocalLeafServer };
