const fs = require("node:fs");
const path = require("node:path");

const MAX_PREFERENCE_KEYS = 256;
const MAX_PREFERENCE_VALUE_BYTES = 256 * 1024;
const MAX_PREFERENCES_BYTES = 2 * 1024 * 1024;

function sanitizeDesktopPreferences(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result = {};
  let totalBytes = 0;
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_PREFERENCE_KEYS) break;
    if (!/^localleaf\.[A-Za-z0-9._-]{1,120}$/.test(key) || typeof value !== "string") continue;
    const entryBytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (entryBytes > MAX_PREFERENCE_VALUE_BYTES || totalBytes + entryBytes > MAX_PREFERENCES_BYTES) continue;
    result[key] = value;
    totalBytes += entryBytes;
    count += 1;
  }
  return result;
}

function readDesktopPreferences(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sanitizeDesktopPreferences(payload?.values);
  } catch {
    return null;
  }
}

function writeDesktopPreferences(filePath, input) {
  const values = sanitizeDesktopPreferences(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, values }, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  return values;
}

module.exports = {
  readDesktopPreferences,
  sanitizeDesktopPreferences,
  writeDesktopPreferences
};
