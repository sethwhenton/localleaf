const assert = require("node:assert/strict");
const test = require("node:test");

const { createDeterministicPdf } = require("./helpers/rendered-smoke-fixture");

test("rendered smoke fixture is a real one-page PDF with drawing operations", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: createDeterministicPdf() }).promise;

  try {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const operatorList = await page.getOperatorList();
    assert.ok(operatorList.fnArray.length >= 4);
  } finally {
    await document.destroy();
  }
});

test("rendered smoke fixture can create a deterministic multi-page PDF", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: createDeterministicPdf({ pageCount: 2 }) }).promise;

  try {
    assert.equal(document.numPages, 2);
    const secondPage = await document.getPage(2);
    const operatorList = await secondPage.getOperatorList();
    assert.ok(operatorList.fnArray.length >= 4);
  } finally {
    await document.destroy();
  }
});
