const fs = require("node:fs");
const path = require("node:path");

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

const TEXT_FILENAMES = new Set([
  "latexmkrc",
  "makefile",
  ".latexmkrc"
]);

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("A file path is required.");
  }

  const unixPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.isAbsolute(unixPath) || unixPath.includes("\0")) {
    throw new Error("Absolute or invalid paths are not allowed.");
  }

  const parts = unixPath.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error("Path traversal is not allowed.");
    }

    const base = part.split(".")[0].toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) {
      throw new Error(`Reserved Windows filename is not allowed: ${part}`);
    }
  }

  return parts.join("/");
}

function resolveProjectPath(projectRoot, relativePath) {
  const cleanRelativePath = normalizeRelativePath(relativePath);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, cleanRelativePath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (target !== root && !target.startsWith(rootWithSeparator)) {
    throw new Error("Resolved path is outside the project.");
  }

  return target;
}

function ensureInsideProject(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (target !== root && !target.startsWith(rootWithSeparator)) {
    throw new Error("Path is outside the project.");
  }

  return target;
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (TEXT_FILENAMES.has(name)) return true;
  return new Set([
    ".tex",
    ".bib",
    ".bst",
    ".cls",
    ".sty",
    ".clo",
    ".cfg",
    ".def",
    ".ldf",
    ".bbx",
    ".cbx",
    ".bbl",
    ".txt",
    ".md",
    ".latex",
    ".tikz",
    ".csv",
    ".dat",
    ".json",
    ".asy",
    ".py"
  ]).has(ext);
}

function isImageFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".pdf",
    ".eps"
  ]).has(ext);
}

function listProjectFiles(projectRoot) {
  const root = path.resolve(projectRoot);
  const files = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      ensureInsideProject(root, fullPath);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        files.push({
          path: relativePath,
          name: entry.name,
          size: 0,
          type: "directory",
          modifiedAt: fs.statSync(fullPath).mtimeMs
        });
        walk(fullPath);
        continue;
      }

      const stats = fs.statSync(fullPath);
      files.push({
        path: relativePath,
        name: entry.name,
        size: stats.size,
        type: isTextFile(fullPath) ? "text" : isImageFile(fullPath) ? "image" : "binary",
        modifiedAt: stats.mtimeMs
      });
    }
  }

  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function getProjectSize(projectRoot) {
  return listProjectFiles(projectRoot)
    .filter((file) => file.type !== "directory")
    .reduce((total, file) => total + file.size, 0);
}

function detectMainFile(projectRoot) {
  const files = listProjectFiles(projectRoot).filter((file) => file.type === "text" && file.path.endsWith(".tex"));
  const main = files.find((file) => file.path.toLowerCase() === "main.tex");
  if (main) return main.path;

  const rootDocument = files.find((file) => {
    if (file.path.includes("/")) return false;
    const content = fs.readFileSync(resolveProjectPath(projectRoot, file.path), "utf8");
    return /\\documentclass(?:\[[^\]]*\])?\{/.test(content);
  });
  if (rootDocument) return rootDocument.path;

  const document = files.find((file) => {
    const content = fs.readFileSync(resolveProjectPath(projectRoot, file.path), "utf8");
    return /\\documentclass(?:\[[^\]]*\])?\{/.test(content);
  });
  return (document || files[0] || { path: "" }).path;
}

module.exports = {
  detectMainFile,
  ensureInsideProject,
  getProjectSize,
  isImageFile,
  isTextFile,
  listProjectFiles,
  normalizeRelativePath,
  resolveProjectPath
};
