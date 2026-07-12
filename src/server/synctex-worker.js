const fs = require("node:fs");
const path = require("node:path");
const { parentPort } = require("node:worker_threads");
const {
  forwardSearch,
  parseSynctexRecords,
  readSynctexText,
  reverseSearch
} = require("./synctex-js");

const MAX_INPUT_PATH_LENGTH = 32_768;
const MAX_RESULT_PATH_LENGTH = 4_096;

let cachedArtifact = null;
let requestQueue = Promise.resolve();

function failure(code = "SYNCTEX_PARSE_FAILED") {
  return {
    ok: false,
    code: String(code || "SYNCTEX_PARSE_FAILED").slice(0, 64),
    reason: "The bundled SyncTeX reader could not map this PDF."
  };
}

function artifactKey(resolvedPath, stat) {
  return `${resolvedPath}\u0000${stat.size.toString()}\u0000${stat.mtimeNs.toString()}`;
}

async function statArtifact(resolvedPath) {
  const stat = await fs.promises.stat(resolvedPath, { bigint: true });
  if (!stat.isFile()) {
    throw Object.assign(new Error("SyncTeX data is not a file."), { code: "INVALID_FILE" });
  }
  return stat;
}

function smallMappedResult(mapped) {
  if (!mapped) {
    return {
      ok: false,
      code: "UNMAPPED",
      reason: "That PDF location is not mapped to editable source."
    };
  }
  const sourcePath = String(mapped.path || "");
  const line = Number(mapped.line);
  const column = Number(mapped.column || 0);
  if (
    !sourcePath
    || sourcePath.length > MAX_RESULT_PATH_LENGTH
    || !Number.isSafeInteger(line)
    || line < 1
    || !Number.isSafeInteger(column)
    || column < 0
  ) {
    return failure("INVALID_RESULT");
  }
  return { ok: true, path: sourcePath, line, column };
}

function smallForwardResult(mapped) {
  if (!mapped) {
    return {
      ok: false,
      code: "UNMAPPED",
      reason: "That source position is not mapped to the compiled PDF."
    };
  }
  const page = Number(mapped.page);
  const x = Number(mapped.x);
  const y = Number(mapped.y);
  const width = Number(mapped.width);
  const height = Number(mapped.height);
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || width < 0
    || !Number.isFinite(height)
    || height < 0
  ) {
    return failure("INVALID_RESULT");
  }
  return { ok: true, page, x, y, width, height };
}

async function lookup(input = {}, options = {}, operation = "reverse") {
  try {
    const suppliedPath = String(input.synctexPath || "");
    if (!suppliedPath || suppliedPath.length > MAX_INPUT_PATH_LENGTH) {
      return failure("INVALID_INPUT");
    }

    let lookupInput;
    if (operation === "forward") {
      const sourcePath = String(input.sourcePath || "");
      const relativePath = String(input.relativePath || "");
      const line = Number(input.line);
      const column = Number(input.column || 0);
      if (
        (!sourcePath && !relativePath)
        || sourcePath.length > MAX_INPUT_PATH_LENGTH
        || relativePath.length > MAX_RESULT_PATH_LENGTH
        || !Number.isSafeInteger(line)
        || line < 1
        || !Number.isSafeInteger(column)
        || column < 0
      ) {
        return failure("INVALID_INPUT");
      }
      lookupInput = { sourcePath, relativePath, line, column };
    } else if (operation === "reverse") {
      const page = Number(input.page);
      const x = Number(input.x);
      const y = Number(input.y);
      if (
        !Number.isFinite(page)
        || page < 1
        || !Number.isFinite(x)
        || x < 0
        || !Number.isFinite(y)
        || y < 0
      ) {
        return failure("INVALID_INPUT");
      }
      lookupInput = { page, x, y };
    } else {
      return failure("INVALID_INPUT");
    }

    const resolvedPath = path.resolve(suppliedPath);
    const beforeStat = await statArtifact(resolvedPath);
    const beforeKey = artifactKey(resolvedPath, beforeStat);
    let parsed = cachedArtifact?.key === beforeKey ? cachedArtifact.parsed : null;
    if (!parsed) {
      // Release the previous parsed artifact before reading a replacement so
      // this worker never intentionally retains more than one cache entry.
      cachedArtifact = null;
      const text = await readSynctexText(resolvedPath, options);
      parsed = parseSynctexRecords(text, options);
      const afterStat = await statArtifact(resolvedPath);
      if (artifactKey(resolvedPath, afterStat) !== beforeKey) {
        throw Object.assign(new Error("SyncTeX data changed while it was being read."), {
          code: "ARTIFACT_CHANGED"
        });
      }
      cachedArtifact = { key: beforeKey, parsed };
    }

    return operation === "forward"
      ? smallForwardResult(forwardSearch(parsed, lookupInput))
      : smallMappedResult(reverseSearch(parsed, lookupInput));
  } catch (error) {
    return failure(error?.code);
  }
}

function postResult(id, result) {
  parentPort.postMessage({ id, result });
}

if (!parentPort) {
  throw new Error("The SyncTeX worker must run inside a worker thread.");
}

parentPort.on("message", (message) => {
  const id = Number(message?.id);
  if (!Number.isSafeInteger(id) || id < 1) return;
  const operation = message?.operation === "forward" ? "forward" : "reverse";
  requestQueue = requestQueue
    .then(() => lookup(message.input, message.options, operation))
    .then((result) => postResult(id, result))
    .catch(() => postResult(id, failure("WORKER_REQUEST_FAILED")));
});
