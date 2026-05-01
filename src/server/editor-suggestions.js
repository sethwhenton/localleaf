const fs = require("node:fs");
const path = require("node:path");
const { resolveProjectPath } = require("./safe-path");

const MAX_SCAN_BYTES = 1_500_000;

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function addMatches(target, content, regex, group = 1) {
  for (const match of content.matchAll(regex)) {
    const value = match[group];
    if (value) target.push(value.trim());
  }
}

function readSuggestionFile(projectRoot, filePath) {
  const fullPath = resolveProjectPath(projectRoot, filePath);
  const stats = fs.statSync(fullPath);
  if (!stats.isFile() || stats.size > MAX_SCAN_BYTES) return "";
  return fs.readFileSync(fullPath, "utf8");
}

function collectProjectEditorSuggestions(projectRoot, files = []) {
  const labels = [];
  const citations = [];
  const macros = [];
  const environments = [];
  const packages = [];

  for (const file of files) {
    if (file.type !== "text") continue;
    let content = "";
    try {
      content = readSuggestionFile(projectRoot, file.path);
    } catch {
      continue;
    }

    addMatches(labels, content, /\\label\s*\{([^}]+)\}/g);
    addMatches(citations, content, /\\bibitem(?:\[[^\]]*])?\s*\{([^}]+)\}/g);
    addMatches(citations, content, /@\w+\s*\{\s*([^,\s}]+)\s*,/g);
    addMatches(macros, content, /\\(?:newcommand|renewcommand)\*?\s*\{\\([A-Za-z@]+)\}/g);
    addMatches(macros, content, /\\(?:def|gdef|edef|xdef)\\([A-Za-z@]+)/g);
    addMatches(macros, content, /\\DeclareMathOperator\*?\s*\{\\([A-Za-z@]+)\}/g);
    addMatches(environments, content, /\\(?:newenvironment|renewenvironment)\*?\s*\{([^}]+)\}/g);

    for (const match of content.matchAll(/\\usepackage(?:\[[^\]]*])?\s*\{([^}]+)\}/g)) {
      const names = String(match[1] || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      packages.push(...names);
    }

    if (path.extname(file.path).toLowerCase() === ".bib") {
      addMatches(citations, content, /@\w+\s*\{\s*([^,\s}]+)\s*,/g);
    }
  }

  return {
    labels: uniqueSorted(labels),
    citations: uniqueSorted(citations),
    macros: uniqueSorted(macros),
    environments: uniqueSorted(environments),
    packages: uniqueSorted(packages)
  };
}

module.exports = {
  collectProjectEditorSuggestions
};
