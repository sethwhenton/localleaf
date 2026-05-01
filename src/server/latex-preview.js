function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractCommand(source, command) {
  const pattern = new RegExp(`\\\\${command}\\s*\\{([^}]*)\\}`, "m");
  return source.match(pattern)?.[1]?.trim() || "";
}

function stripLatex(source) {
  return source
    .replace(/%.*$/gm, "")
    .replace(/\\input\{([^}]*)\}/g, "[$1]")
    .replace(/\\usepackage(?:\[[^\]]*\])?\{[^}]*\}/g, "")
    .replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]*\}/g, "")
    .replace(/\\begin\{document\}|\\end\{document\}/g, "")
    .replace(/\\maketitle/g, "")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{([^}]*)\})?/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderLatexPreview(source, includedFiles = new Map()) {
  let expanded = source.replace(/\\input\{([^}]*)\}/g, (_, inputPath) => {
    const key = inputPath.endsWith(".tex") ? inputPath : `${inputPath}.tex`;
    return includedFiles.get(key) || `\\textit{Missing input: ${key}}`;
  });

  const title = extractCommand(expanded, "title") || "Untitled Project";
  const author = extractCommand(expanded, "author") || "";
  const date = extractCommand(expanded, "date") || "";
  const sections = [];
  const sectionPattern = /\\section\*?\{([^}]*)\}([\s\S]*?)(?=\\section\*?\{|\\end\{document\}|$)/g;
  let match;

  while ((match = sectionPattern.exec(expanded)) !== null) {
    sections.push({
      title: match[1].trim(),
      body: stripLatex(match[2])
    });
  }

  const fallbackBody = stripLatex(expanded);
  const sectionHtml = sections.length
    ? sections
        .map(
          (section, index) => `
            <section class="paper-section">
              <h2>${index + 1}. ${escapeHtml(section.title)}</h2>
              <p>${escapeHtml(section.body || " ")}</p>
            </section>
          `
        )
        .join("")
    : `<section class="paper-section"><p>${escapeHtml(fallbackBody)}</p></section>`;

  return `
    <article class="paper-preview">
      <header class="paper-title">
        <h1>${escapeHtml(title)}</h1>
        ${author ? `<p>${escapeHtml(author)}</p>` : ""}
        ${date ? `<p>${escapeHtml(date)}</p>` : ""}
      </header>
      ${sectionHtml}
      <footer class="paper-page-number">1</footer>
    </article>
  `;
}

module.exports = {
  escapeHtml,
  renderLatexPreview,
  stripLatex
};
