const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readDesktopPreferences,
  sanitizeDesktopPreferences,
  writeDesktopPreferences
} = require("../src/desktop/preferences");

test("sanitizes renderer preferences to LocalLeaf string keys", () => {
  const sanitized = sanitizeDesktopPreferences({
    "localleaf.theme": "dark",
    "localleaf.tunnelProvider.v1": "cloudflare",
    "other.token": "do not persist",
    "localleaf.invalid value": "no",
    "localleaf.object": { nested: true }
  });
  assert.deepEqual(sanitized, {
    "localleaf.theme": "dark",
    "localleaf.tunnelProvider.v1": "cloudflare"
  });
});

test("persists renderer preferences independently of the server origin port", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-desktop-preferences-"));
  const filePath = path.join(root, "renderer-preferences.json");
  try {
    assert.equal(readDesktopPreferences(filePath), null);
    writeDesktopPreferences(filePath, {
      "localleaf.theme": "dark",
      "localleaf.sidebarWidth": "312"
    });
    assert.deepEqual(readDesktopPreferences(filePath), {
      "localleaf.theme": "dark",
      "localleaf.sidebarWidth": "312"
    });

    writeDesktopPreferences(filePath, { "localleaf.theme": "light" });
    assert.deepEqual(readDesktopPreferences(filePath), { "localleaf.theme": "light" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
