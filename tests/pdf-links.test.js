const test = require("node:test");
const assert = require("node:assert/strict");

test("PDF external-link descriptors keep only safe HTTPS annotations and normalize rectangles", async () => {
  const { pdfExternalLinkDescriptors, trustedPdfExternalHref } = await import("../src/client/pdf-links.mjs");
  const descriptors = pdfExternalLinkDescriptors([
    { url: "https://example.com/paper", rect: [10, 20, 40, 30], title: "Open paper" },
    { url: "javascript:alert(1)", rect: [0, 0, 10, 10] },
    { url: "https://user:secret@example.com/private", rect: [0, 0, 10, 10] },
    { dest: "section.1", rect: [0, 0, 10, 10] }
  ], (rect) => [rect[0] * 2, rect[3] * 2, rect[2] * 2, rect[1] * 2]);

  assert.deepEqual(descriptors, [{
    href: "https://example.com/paper",
    label: "Open paper",
    left: 20,
    top: 40,
    width: 60,
    height: 20
  }]);
  assert.equal(trustedPdfExternalHref("http://example.com"), "");
  assert.equal(trustedPdfExternalHref("data:text/html,hello"), "");
});

test("PDF external-link hitboxes scale with the rendered page during progressive zoom", async () => {
  const { scalePdfExternalLinkDescriptor } = await import("../src/client/pdf-links.mjs");
  const original = {
    href: "https://example.com/paper",
    label: "Open paper",
    left: 20,
    top: 40,
    width: 60,
    height: 20
  };

  const scaled = scalePdfExternalLinkDescriptor(original, 1.5);

  assert.deepEqual(scaled, {
    href: "https://example.com/paper",
    label: "Open paper",
    left: 30,
    top: 60,
    width: 90,
    height: 30
  });
  assert.deepEqual(original, {
    href: "https://example.com/paper",
    label: "Open paper",
    left: 20,
    top: 40,
    width: 60,
    height: 20
  });
});
