function createDeterministicPdf(options = {}) {
  const pageCount = Math.max(1, Math.min(8, Number(options.pageCount) || 1));
  const pageIds = Array.from({ length: pageCount }, (_unused, index) => 3 + (index * 2));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`
  ];
  pageIds.forEach((pageId, index) => {
    const contentId = pageId + 1;
    const content = [
      "0.97 g",
      "0 0 612 792 re",
      "f",
      index % 2 ? "0.12 0.12 0.12 rg" : "1 0.38 0 rg",
      `${72 + (index * 12)} ${620 - (index * 24)} ${468 - (index * 24)} 72 re`,
      "f"
    ].join("\n") + "\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`
    );
  });

  let body = "%PDF-1.7\n% LocalLeaf deterministic rendered smoke fixture\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "ascii"));
}

module.exports = {
  createDeterministicPdf
};
