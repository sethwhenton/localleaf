const fs = require("node:fs");
const zlib = require("node:zlib");

// Parser and reverse-search selection adapted from LaTeX Workshop's MIT-licensed
// synctexjs implementation pinned in THIRD_PARTY_NOTICES.md.
const SYNCTEX_POINTS_UNIT = 65781.76;
const DEFAULT_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINES = 1_000_000;
const DEFAULT_MAX_RECORDS = 500_000;
const MAX_FORWARD_LINE_DISTANCE = 2;

function boundedPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function gunzipBounded(buffer, maxOutputLength) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, { maxOutputLength }, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
  });
}

async function readSynctexText(synctexPath, options = {}) {
  const maxCompressedBytes = boundedPositiveInteger(
    options.maxCompressedBytes,
    DEFAULT_MAX_COMPRESSED_BYTES,
    DEFAULT_MAX_COMPRESSED_BYTES
  );
  const maxInflatedBytes = boundedPositiveInteger(
    options.maxInflatedBytes,
    DEFAULT_MAX_INFLATED_BYTES,
    DEFAULT_MAX_INFLATED_BYTES
  );
  const stat = await fs.promises.stat(synctexPath);
  if (!stat.isFile()) throw Object.assign(new Error("SyncTeX data is not a file."), { code: "INVALID_FILE" });
  if (stat.size > maxCompressedBytes) {
    throw Object.assign(new Error("Compressed SyncTeX data exceeds the safety limit."), { code: "COMPRESSED_LIMIT" });
  }
  const compressed = await fs.promises.readFile(synctexPath);
  if (compressed.length > maxCompressedBytes) {
    throw Object.assign(new Error("Compressed SyncTeX data exceeds the safety limit."), { code: "COMPRESSED_LIMIT" });
  }
  let inflated;
  try {
    inflated = await gunzipBounded(compressed, maxInflatedBytes);
  } catch (error) {
    const code = error?.code === "ERR_BUFFER_TOO_LARGE" ? "INFLATED_LIMIT" : "INVALID_GZIP";
    throw Object.assign(new Error(
      code === "INFLATED_LIMIT"
        ? "Inflated SyncTeX data exceeds the safety limit."
        : "SyncTeX data could not be decompressed."
    ), { code });
  }
  if (inflated.length > maxInflatedBytes) {
    throw Object.assign(new Error("Inflated SyncTeX data exceeds the safety limit."), { code: "INFLATED_LIMIT" });
  }
  return inflated.toString("utf8");
}

function rectangleForRecord(record) {
  const firstX = record.left;
  const secondX = record.left + (record.width || 0);
  const firstY = record.bottom;
  const secondY = record.bottom - record.height;
  return {
    left: Math.min(firstX, secondX),
    right: Math.max(firstX, secondX),
    top: Math.min(firstY, secondY),
    bottom: Math.max(firstY, secondY)
  };
}

function rectangleIncludes(outer, inner) {
  return outer.left <= inner.left
    && outer.right >= inner.right
    && outer.top <= inner.top
    && outer.bottom >= inner.bottom;
}

function distanceFromRectangleCenter(rectangle, x, y) {
  return Math.hypot(
    ((rectangle.left + rectangle.right) / 2) - x,
    ((rectangle.top + rectangle.bottom) / 2) - y
  );
}

function parseSynctexRecords(text, options = {}) {
  const maxLines = boundedPositiveInteger(options.maxLines, DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
  const maxRecords = boundedPositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, DEFAULT_MAX_RECORDS);
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > maxLines) {
    throw Object.assign(new Error("SyncTeX data has too many lines."), { code: "LINE_LIMIT" });
  }
  if (!lines[0]?.startsWith("SyncTeX Version:")) {
    throw Object.assign(new Error("SyncTeX header is invalid."), { code: "INVALID_FORMAT" });
  }

  const files = new Map();
  const records = [];
  const blockStack = [];
  const offset = { x: 0, y: 0 };
  let currentPage = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    let match = /^Input:(\d+):(.+)$/.exec(line);
    if (match) {
      files.set(Number(match[1]), match[2]);
      continue;
    }
    match = /^(X|Y) Offset:(-?\d+)$/.exec(line);
    if (match) {
      offset[match[1].toLowerCase()] = Number(match[2]) / SYNCTEX_POINTS_UNIT;
      continue;
    }
    match = /^\{(\d+)$/.exec(line);
    if (match) {
      currentPage = Number(match[1]);
      blockStack.length = 0;
      continue;
    }
    if (/^\}\d+$/.test(line)) {
      currentPage = 0;
      blockStack.length = 0;
      continue;
    }

    match = /^(?:\[|\()(\d+),(\d+):(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)/.exec(line);
    if (match && currentPage) {
      blockStack.push({
        height: Number(match[6]) / SYNCTEX_POINTS_UNIT
      });
      continue;
    }
    if (line === "]" || line === ")") {
      blockStack.pop();
      continue;
    }

    match = /^([^\d\s])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+))?/.exec(line);
    const parent = blockStack[blockStack.length - 1];
    if (!match || !currentPage || !parent || match[1] === "k" || match[1] === "r") continue;
    const file = files.get(Number(match[2]));
    if (!file) continue;
    records.push({
      page: currentPage,
      path: file,
      line: Number(match[3]),
      left: Number(match[4]) / SYNCTEX_POINTS_UNIT,
      bottom: Number(match[5]) / SYNCTEX_POINTS_UNIT,
      width: match[6] === undefined ? 0 : Number(match[6]) / SYNCTEX_POINTS_UNIT,
      height: parent.height
    });
    if (records.length > maxRecords) {
      throw Object.assign(new Error("SyncTeX data has too many records."), { code: "RECORD_LIMIT" });
    }
  }

  return { offset, records };
}

function reverseSearch(parsed, input = {}) {
  const page = Number(input.page);
  const x = Number(input.x) - parsed.offset.x;
  const y = Number(input.y) - parsed.offset.y;
  let selected = null;

  for (const record of parsed.records) {
    if (record.page !== page || !Number.isSafeInteger(record.line) || record.line < 1) continue;
    const rectangle = rectangleForRecord(record);
    const distance = distanceFromRectangleCenter(rectangle, x, y);
    if (
      !selected
      || rectangleIncludes(selected.rectangle, rectangle)
      || (distance < selected.distance && !rectangleIncludes(rectangle, selected.rectangle))
    ) {
      selected = { record, rectangle, distance };
    }
  }

  if (!selected) return null;
  return {
    ok: true,
    path: selected.record.path,
    line: selected.record.line,
    column: 0
  };
}

function normalizedSourcePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function pathEndsWithPath(candidate, suffix) {
  return candidate === suffix || candidate.endsWith(`/${suffix}`);
}

function sourcePathMatchRank(recordPath, sourcePath, relativePath) {
  const record = normalizedSourcePath(recordPath);
  const absolute = normalizedSourcePath(sourcePath);
  const relative = normalizedSourcePath(relativePath);
  if (!record || (!absolute && !relative)) return 0;

  const windowsPath = /^[a-zA-Z]:\//.test(record) || /^[a-zA-Z]:\//.test(absolute);
  const comparableRecord = windowsPath ? record.toLowerCase() : record;
  const comparableAbsolute = windowsPath ? absolute.toLowerCase() : absolute;
  const comparableRelative = windowsPath ? relative.toLowerCase() : relative;

  if (comparableAbsolute && comparableRecord === comparableAbsolute) return 4;
  if (comparableRelative && comparableRecord === comparableRelative) return 3;
  if (
    comparableAbsolute
    && (pathEndsWithPath(comparableRecord, comparableAbsolute)
      || pathEndsWithPath(comparableAbsolute, comparableRecord))
  ) {
    return 2;
  }
  if (
    comparableRelative
    && (pathEndsWithPath(comparableRecord, comparableRelative)
      || pathEndsWithPath(comparableRelative, comparableRecord))
  ) {
    return 1;
  }
  return 0;
}

function forwardSearch(parsed, input = {}) {
  if (!parsed || !Array.isArray(parsed.records)) return null;
  const sourcePath = normalizedSourcePath(input.sourcePath);
  const relativePath = normalizedSourcePath(input.relativePath);
  const line = Number(input.line);
  const column = Number(input.column || 0);
  if (
    (!sourcePath && !relativePath)
    || !Number.isSafeInteger(line)
    || line < 1
    || !Number.isSafeInteger(column)
    || column < 0
  ) {
    return null;
  }

  let bestPathRank = 0;
  const matchingRecords = [];
  for (const record of parsed.records) {
    if (!Number.isSafeInteger(record.page) || record.page < 1) continue;
    if (!Number.isSafeInteger(record.line) || record.line < 1) continue;
    const rank = sourcePathMatchRank(record.path, sourcePath, relativePath);
    if (!rank || rank < bestPathRank) continue;
    if (rank > bestPathRank) {
      bestPathRank = rank;
      matchingRecords.length = 0;
    }
    matchingRecords.push(record);
  }
  if (!matchingRecords.length) return null;

  const matchedPaths = new Set(matchingRecords.map((record) => normalizedSourcePath(record.path)));
  if (bestPathRank <= 1 && matchedPaths.size > 1) return null;

  let nearestLineDistance = Number.POSITIVE_INFINITY;
  for (const record of matchingRecords) {
    nearestLineDistance = Math.min(nearestLineDistance, Math.abs(record.line - line));
  }
  if (nearestLineDistance > MAX_FORWARD_LINE_DISTANCE) return null;

  const lineRecords = matchingRecords.filter((record) => Math.abs(record.line - line) === nearestLineDistance);
  const nearestLines = new Set(lineRecords.map((record) => record.line));
  if (nearestLineDistance > 0 && nearestLines.size > 1) return null;

  let selected = null;
  for (const record of lineRecords) {
    const rectangle = rectangleForRecord(record);
    const width = rectangle.right - rectangle.left;
    const height = rectangle.bottom - rectangle.top;
    if (![rectangle.left, rectangle.top, width, height].every(Number.isFinite)) continue;
    const hasArea = width > 0 && height > 0;
    if (
      !selected
      || (hasArea && !selected.hasArea)
      || (hasArea === selected.hasArea && record.page < selected.record.page)
      || (
        hasArea === selected.hasArea
        && record.page === selected.record.page
        && rectangle.top < selected.rectangle.top
      )
    ) {
      selected = { record, rectangle, width, height, hasArea };
    }
  }
  if (!selected) return null;

  const x = selected.rectangle.left + Number(parsed.offset?.x || 0);
  const y = selected.rectangle.top + Number(parsed.offset?.y || 0);
  if (![x, y, selected.width, selected.height].every(Number.isFinite)) return null;
  return {
    ok: true,
    page: selected.record.page,
    x,
    y,
    width: Math.max(0, selected.width),
    height: Math.max(0, selected.height)
  };
}

async function resolveSynctexPosition(input = {}, options = {}) {
  try {
    const text = await readSynctexText(input.synctexPath, options);
    const parsed = parseSynctexRecords(text, options);
    const mapped = reverseSearch(parsed, input);
    return mapped || { ok: false, code: "UNMAPPED", reason: "That PDF location is not mapped to editable source." };
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code || "SYNCTEX_PARSE_FAILED"),
      reason: "The bundled SyncTeX reader could not map this PDF."
    };
  }
}

async function resolveSynctexOutputPosition(input = {}, options = {}) {
  try {
    const text = await readSynctexText(input.synctexPath, options);
    const parsed = parseSynctexRecords(text, options);
    const mapped = forwardSearch(parsed, input);
    return mapped || {
      ok: false,
      code: "UNMAPPED",
      reason: "That source position is not mapped to the compiled PDF."
    };
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code || "SYNCTEX_PARSE_FAILED"),
      reason: "The bundled SyncTeX reader could not map this source position to the PDF."
    };
  }
}

module.exports = {
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_INFLATED_BYTES,
  MAX_FORWARD_LINE_DISTANCE,
  forwardSearch,
  parseSynctexRecords,
  readSynctexText,
  resolveSynctexOutputPosition,
  resolveSynctexPosition,
  reverseSearch
};
