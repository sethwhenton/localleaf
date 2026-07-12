const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { renderLatexPreview } = require("./latex-preview");
const { listProjectFiles, resolveProjectPath } = require("./safe-path");

const ROOT = path.resolve(__dirname, "../..");
const PLATFORM_EXE = process.platform === "win32" ? ".exe" : "";
const DIRECT_LATEX_ENGINES = new Set(["lualatex", "pdflatex", "xelatex"]);
const COMPILE_LOG_MAX_BYTES = 512 * 1024;
const COMPILE_LOG_MAX_LINES = 2000;
const COMPILE_LOG_TRUNCATION_MARKER = "[LocalLeaf] Earlier compiler output was truncated to keep the app responsive.";
const COMPILER_ENVIRONMENT_KEYS = new Set([
  "appdata",
  "bibinputs",
  "bstinputs",
  "comspec",
  "dyld_library_path",
  "fontconfig_file",
  "fontconfig_path",
  "home",
  "homedrive",
  "homepath",
  "lang",
  "language",
  "lc_all",
  "lc_ctype",
  "ld_library_path",
  "localappdata",
  "luainputs",
  "miktex_commonconfig",
  "miktex_commondata",
  "miktex_commoninstall",
  "miktex_userconfig",
  "miktex_userdata",
  "miktex_userinstall",
  "path",
  "pathext",
  "programdata",
  "source_date_epoch",
  "ssl_cert_dir",
  "ssl_cert_file",
  "systemroot",
  "tectonic_cache_dir",
  "temp",
  "texinputs",
  "texmfcnf",
  "texmfconfig",
  "texmfhome",
  "texmflocal",
  "texmfsysconfig",
  "texmfsysvar",
  "texmfvar",
  "tmp",
  "tmpdir",
  "tz",
  "userprofile",
  "windir",
  "xdg_cache_home",
  "xdg_config_home",
  "xdg_data_home"
]);

function buildCompilerEnvironment(sourceEnvironment = process.env) {
  return Object.fromEntries(
    Object.entries(sourceEnvironment).filter(([key, value]) => (
      value !== undefined && COMPILER_ENVIRONMENT_KEYS.has(key.toLowerCase())
    ))
  );
}

function buildCompilerArguments(engine, { mainFile, outputDir }) {
  if (engine === "tectonic") {
    return ["--untrusted", "--synctex", "--outdir", outputDir, mainFile];
  }
  if (engine === "latexmk") {
    return [
      "-pdf",
      `-outdir=${outputDir}`,
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      "-latexoption=-no-shell-escape",
      mainFile
    ];
  }
  if (DIRECT_LATEX_ENGINES.has(engine)) {
    return [
      "-no-shell-escape",
      "-interaction=nonstopmode",
      "-file-line-error",
      "-synctex=1",
      `-output-directory=${outputDir}`,
      mainFile
    ];
  }
  throw new Error(`Unsupported compiler engine: ${engine}`);
}

function commandExists(command) {
  if (command && (path.isAbsolute(command) || command.includes(path.sep))) {
    return fs.existsSync(command);
  }

  const probe = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(probe, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}

function findBundledTectonic() {
  const executable = `tectonic${PLATFORM_EXE}`;
  const candidates = [
    process.env.LOCALLEAF_TECTONIC_PATH,
    path.join(ROOT, "bin", executable),
    process.resourcesPath ? path.join(process.resourcesPath, "bin", executable) : ""
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function findTectonic() {
  const bundled = findBundledTectonic();
  if (bundled) {
    return {
      command: bundled,
      bundled: true,
      label: "Bundled Tectonic ready"
    };
  }

  if (commandExists("tectonic")) {
    return {
      command: "tectonic",
      bundled: false,
      label: "Tectonic ready"
    };
  }

  return null;
}

function detectCompiler() {
  if (process.env.LOCALLEAF_FORCE_PREVIEW === "1") {
    return {
      available: false,
      engine: "preview",
      label: "Preview fallback forced for testing"
    };
  }

  const tectonic = findTectonic();
  const preferSystemLatex = process.env.LOCALLEAF_PREFER_SYSTEM_LATEX === "1";
  if (tectonic && !preferSystemLatex) {
    return {
      available: true,
      engine: "tectonic",
      command: tectonic.command,
      bundled: tectonic.bundled,
      label: tectonic.label
    };
  }

  if (commandExists("latexmk")) {
    return { available: true, engine: "latexmk", command: "latexmk", label: "latexmk ready" };
  }

  if (tectonic) {
    return {
      available: true,
      engine: "tectonic",
      command: tectonic.command,
      bundled: tectonic.bundled,
      label: tectonic.label
    };
  }

  if (commandExists("pdflatex")) {
    return { available: true, engine: "pdflatex", command: "pdflatex", label: "pdfLaTeX ready" };
  }

  if (commandExists("xelatex")) {
    return { available: true, engine: "xelatex", command: "xelatex", label: "XeLaTeX ready" };
  }

  if (commandExists("lualatex")) {
    return { available: true, engine: "lualatex", command: "lualatex", label: "LuaLaTeX ready" };
  }

  return {
    available: false,
    engine: "preview",
    label: "Install MiKTeX, TeX Live, Tectonic, or latexmk for PDF output"
  };
}

function readIncludedFiles(projectRoot) {
  const included = new Map();
  for (const file of listProjectFiles(projectRoot)) {
    if (file.type === "text" && file.path.toLowerCase().endsWith(".tex")) {
      included.set(file.path, fs.readFileSync(resolveProjectPath(projectRoot, file.path), "utf8"));
    }
  }
  return included;
}

function normalizeProcessExitCode(result = {}) {
  if (result.timedOut) return 124;
  if (result.outputLimitExceeded) return 125;
  return Number.isInteger(result.code) ? result.code : 1;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: buildCompilerEnvironment(process.env)
    });

    let output = "";
    const maxOutputBytes = Math.max(16 * 1024, Number(options.maxOutputBytes || 2 * 1024 * 1024));
    const outputLimitMarker = "\n[LocalLeaf] Compiler output exceeded the safe limit and was stopped.\n";
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const stopChild = () => {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    };
    const appendOutput = (text) => {
      const chunk = Buffer.from(String(text || ""), "utf8");
      if (outputBytes + chunk.length <= maxOutputBytes) {
        output += chunk.toString("utf8");
        outputBytes += chunk.length;
        return true;
      }
      const marker = Buffer.from(outputLimitMarker, "utf8");
      const remaining = Math.max(0, maxOutputBytes - outputBytes - marker.length);
      if (remaining) output += chunk.subarray(0, remaining).toString("utf8");
      output += marker.subarray(0, Math.max(0, maxOutputBytes - Buffer.byteLength(output, "utf8"))).toString("utf8");
      outputBytes = Buffer.byteLength(output, "utf8");
      return false;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      appendOutput("\n[LocalLeaf] Compile timed out and was stopped.\n");
      stopChild();
    }, options.timeoutMs);

    const handleOutput = (chunk) => {
      if (outputLimitExceeded) return;
      const text = chunk.toString();
      const withinLimit = appendOutput(text);
      const cleanText = filterCompilerOutput(withinLimit ? text : outputLimitMarker);
      if (cleanText) options.onData?.(cleanText);
      if (!withinLimit) {
        outputLimitExceeded = true;
        stopChild();
      }
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);

    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ code: 1, signal: null, timedOut, outputLimitExceeded, output: `${output}\n${error.message}` });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settle({ code, signal, timedOut, outputLimitExceeded, output });
    });
  });
}

function isIgnorableCompilerLogLine(line) {
  return /^Fontconfig error: Cannot load default config file: No such file: \(null\)$/i.test(String(line || "").trim());
}

function filterCompilerOutput(output) {
  const lines = String(output || "").split(/\r?\n/);
  const kept = lines.filter((line) => line === "" || !isIgnorableCompilerLogLine(line));
  return kept.join("\n");
}

function splitLogs(output) {
  return String(output || "").split(/\r?\n/).filter((line) => line && !isIgnorableCompilerLogLine(line));
}

function capCompilerLogs(logs, options = {}) {
  const maxBytes = Math.max(256, Number(options.maxBytes || COMPILE_LOG_MAX_BYTES));
  const maxLines = Math.max(1, Number(options.maxLines || COMPILE_LOG_MAX_LINES));
  const lines = (Array.isArray(logs) ? logs : [logs])
    .flatMap((line) => String(line ?? "").split(/\r?\n/))
    .filter(Boolean);
  const markerBytes = Buffer.byteLength(`${COMPILE_LOG_TRUNCATION_MARKER}\n`, "utf8");
  const kept = [];
  let keptBytes = 0;
  let index = lines.length - 1;

  for (; index >= 0 && kept.length < maxLines; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (keptBytes + lineBytes + markerBytes > maxBytes) break;
    kept.push(line);
    keptBytes += lineBytes;
  }

  kept.reverse();
  if (index >= 0 || kept.length < lines.length) kept.unshift(COMPILE_LOG_TRUNCATION_MARKER);
  return kept;
}

function expectedPdfPath(projectRoot, mainFile, outputDir = projectRoot) {
  return path.join(outputDir, `${path.parse(mainFile).name}.pdf`);
}

function expectedSynctexPath(projectRoot, mainFile, outputDir = projectRoot) {
  return path.join(outputDir, `${path.parse(mainFile).name}.synctex.gz`);
}

function hasBibliography(projectRoot, source) {
  if (/\\(?:bibliography|addbibresource)\b/.test(source)) {
    return true;
  }
  return listProjectFiles(projectRoot).some((file) => file.path.toLowerCase().endsWith(".bib"));
}

function preferredDirectEngine(projectRoot, source) {
  const latexmkRcPath = path.join(projectRoot, "latexmkrc");
  const latexmkRc = fs.existsSync(latexmkRcPath) ? fs.readFileSync(latexmkRcPath, "utf8") : "";
  const wantsUnicodeEngine = /\\usepackage(?:\[[^\]]*\])?\{fontspec\}/.test(source) ||
    /(?:lua|xe)latex/i.test(latexmkRc);
  const engines = wantsUnicodeEngine ? ["lualatex", "xelatex", "pdflatex"] : ["pdflatex", "lualatex", "xelatex"];
  return engines.find(commandExists);
}

function findProjectLatexmkConfig(projectRoot) {
  for (const name of ["latexmkrc", ".latexmkrc"]) {
    const candidate = path.join(projectRoot, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or unreadable project config is treated as absent.
    }
  }
  return "";
}

async function runLatexmk(projectRoot, mainFile, outputDir, onData) {
  const result = await runProcess(
    "latexmk",
    buildCompilerArguments("latexmk", { mainFile, outputDir }),
    {
      cwd: projectRoot,
      timeoutMs: 90000,
      onData
    }
  );

  return {
    engine: "latexmk",
    exitCode: normalizeProcessExitCode(result),
    logs: splitLogs(result.output),
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir),
    synctexPath: expectedSynctexPath(projectRoot, mainFile, outputDir)
  };
}

async function runTectonic(projectRoot, mainFile, outputDir, command, onData) {
  const result = await runProcess(command, buildCompilerArguments("tectonic", { mainFile, outputDir }), {
    cwd: projectRoot,
    timeoutMs: 90000,
    onData
  });

  return {
    engine: command === "tectonic" ? "tectonic" : "bundled tectonic",
    exitCode: normalizeProcessExitCode(result),
    logs: splitLogs(result.output),
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir),
    synctexPath: expectedSynctexPath(projectRoot, mainFile, outputDir)
  };
}

async function runDirectEngine(projectRoot, mainFile, source, outputDir, engine, onData) {
  const logs = [];
  let exitCode = 0;
  const latexArgs = buildCompilerArguments(engine, { mainFile, outputDir });

  for (let pass = 1; pass <= 2; pass += 1) {
    logs.push(`[LocalLeaf] ${engine} pass ${pass} started.`);
    const result = await runProcess(engine, latexArgs, {
      cwd: projectRoot,
      timeoutMs: 90000,
      onData
    });
    const latexExitCode = normalizeProcessExitCode(result);
    if (latexExitCode !== 0) exitCode = latexExitCode;
    logs.push(...splitLogs(result.output));

    if (pass === 1 && hasBibliography(projectRoot, source) && commandExists("bibtex")) {
      const auxName = path.join(outputDir, path.parse(mainFile).name);
      logs.push("[LocalLeaf] BibTeX pass started.");
      const bibtex = await runProcess("bibtex", [auxName], {
        cwd: projectRoot,
        timeoutMs: 60000,
        onData
      });
      const bibtexExitCode = normalizeProcessExitCode(bibtex);
      if (bibtexExitCode !== 0) exitCode = bibtexExitCode;
      logs.push(...splitLogs(bibtex.output));
    }
  }

  return {
    engine,
    exitCode,
    logs,
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir),
    synctexPath: expectedSynctexPath(projectRoot, mainFile, outputDir)
  };
}

function cleanupCompileArtifact(candidatePath) {
  if (!candidatePath) return;
  const tempRoot = path.resolve(os.tmpdir());
  const absolute = path.resolve(candidatePath);
  const relative = path.relative(tempRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  const artifactDirectory = relative.split(path.sep)[0];
  if (!artifactDirectory.startsWith("localleaf-compile-")) return;
  const artifactRoot = path.join(tempRoot, artifactDirectory);
  if (fs.existsSync(artifactRoot)) {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
}

function isValidPdfArtifact(filePath) {
  if (!filePath) return false;
  let descriptor = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 10) return false;
    descriptor = fs.openSync(filePath, "r");
    const header = Buffer.alloc(5);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("ascii") !== "%PDF-") return false;
    const tailSize = Math.min(2048, stat.size);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(descriptor, tail, 0, tailSize, stat.size - tailSize);
    return tail.includes(Buffer.from("%%EOF", "ascii"));
  } catch {
    return false;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function createCompileSnapshot(projectRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-"));
  const sourceSnapshotRoot = path.join(artifactRoot, "source");
  const outputDir = path.join(artifactRoot, "output");

  try {
    await fs.promises.cp(resolvedProjectRoot, sourceSnapshotRoot, {
      recursive: true,
      dereference: false,
      filter: async (sourcePath) => {
        const relative = path.relative(resolvedProjectRoot, sourcePath);
        if (!relative) return true;
        const firstSegment = relative.split(path.sep)[0].toLowerCase();
        if (firstSegment === ".git" || firstSegment === "node_modules") return false;
        try {
          return !(await fs.promises.lstat(sourcePath)).isSymbolicLink();
        } catch {
          return false;
        }
      }
    });
    await fs.promises.mkdir(outputDir, { recursive: true });
    return { artifactRoot, sourceSnapshotRoot, outputDir };
  } catch (error) {
    cleanupCompileArtifact(artifactRoot);
    throw error;
  }
}

async function compileProject(projectRoot, mainFile, onData, options = {}) {
  const compiler = detectCompiler();
  const compileSnapshot = options.compileSnapshot || await createCompileSnapshot(projectRoot);
  const compileRoot = compileSnapshot.sourceSnapshotRoot;
  const outputDir = compileSnapshot.outputDir;
  const artifactRoot = compileSnapshot.artifactRoot;
  const mainFilePath = resolveProjectPath(compileRoot, mainFile);
  const source = fs.readFileSync(mainFilePath, "utf8");
  const includedFiles = readIncludedFiles(compileRoot);
  const previewHtml = renderLatexPreview(source, includedFiles);
  const previousPdfPath = options.previousPdfPath;
  const previousSynctexPath = options.previousSynctexPath;
  const previousArtifactRoot = options.previousArtifactRoot;
  const previousSourceSnapshotRoot = options.previousSourceSnapshotRoot;
  let restoredPreviousPdf = false;

  if (!compiler.available) {
    const forced = process.env.LOCALLEAF_FORCE_PREVIEW === "1";
    cleanupCompileArtifact(artifactRoot);
    return {
      ok: forced,
      engine: "preview",
      mode: "html",
      logs: [
        forced
          ? "[LocalLeaf] Preview fallback forced for automated testing."
          : "[LocalLeaf] No native LaTeX compiler was found on PATH.",
        "[LocalLeaf] Install MiKTeX, TeX Live, Tectonic, or latexmk for real PDF output.",
        "[LocalLeaf] Rendered the built-in HTML preview so the project remains readable."
      ],
      previewHtml,
      pdfPath: null,
      synctexPath: null,
      artifactRoot: null,
      sourceSnapshotRoot: null,
      stale: false
    };
  }

  const attempts = [];
  const projectLatexmkConfigPath = findProjectLatexmkConfig(compileRoot);
  const projectLatexmkConfigSkipped = Boolean(projectLatexmkConfigPath) && process.env.LOCALLEAF_ALLOW_LATEXMKRC !== "1";
  const canRunLatexmk = commandExists("latexmk") && !projectLatexmkConfigSkipped;
  const hasProjectLatexmkConfig = process.env.LOCALLEAF_ALLOW_LATEXMKRC === "1" &&
    canRunLatexmk &&
    Boolean(projectLatexmkConfigPath);
  if (hasProjectLatexmkConfig) {
    attempts.push(() => runLatexmk(compileRoot, mainFile, outputDir, onData));
  }

  if (compiler.engine === "latexmk") {
    if (!hasProjectLatexmkConfig && canRunLatexmk) attempts.push(() => runLatexmk(compileRoot, mainFile, outputDir, onData));
    const tectonic = findTectonic();
    if (tectonic) attempts.push(() => runTectonic(compileRoot, mainFile, outputDir, tectonic.command, onData));
    const direct = preferredDirectEngine(compileRoot, source);
    if (direct) attempts.push(() => runDirectEngine(compileRoot, mainFile, source, outputDir, direct, onData));
  } else if (compiler.engine === "tectonic") {
    attempts.push(() => runTectonic(compileRoot, mainFile, outputDir, compiler.command || "tectonic", onData));
    if (canRunLatexmk && !hasProjectLatexmkConfig) attempts.push(() => runLatexmk(compileRoot, mainFile, outputDir, onData));
    const direct = preferredDirectEngine(compileRoot, source);
    if (direct) attempts.push(() => runDirectEngine(compileRoot, mainFile, source, outputDir, direct, onData));
  } else {
    attempts.push(() => runDirectEngine(compileRoot, mainFile, source, outputDir, compiler.command || compiler.engine, onData));
  }

  const logs = [];
  let engine = compiler.engine;
  let producedPdf = null;
  let producedSynctex = null;
  let producedOk = false;

  for (const attempt of attempts) {
    const result = await attempt();
    engine = result.engine;
    logs.push(`[LocalLeaf] Trying ${result.engine}.`);
    logs.push(...result.logs);

    if (result.exitCode !== 0) {
      if (fs.existsSync(result.pdfPath)) {
        logs.push("[LocalLeaf] The compiler produced a PDF but reported errors, so LocalLeaf did not publish that artifact.");
        fs.rmSync(result.pdfPath, { force: true });
        if (result.synctexPath) fs.rmSync(result.synctexPath, { force: true });
      }
      continue;
    }

    if (isValidPdfArtifact(result.pdfPath)) {
      producedPdf = result.pdfPath;
      producedSynctex = result.synctexPath && fs.existsSync(result.synctexPath) ? result.synctexPath : null;
      producedOk = true;
      break;
    }

    if (fs.existsSync(result.pdfPath)) {
      logs.push(`[LocalLeaf] ${result.engine} produced an invalid or incomplete PDF, so LocalLeaf did not publish it.`);
      fs.rmSync(result.pdfPath, { force: true });
      if (result.synctexPath) fs.rmSync(result.synctexPath, { force: true });
    } else {
      logs.push(`[LocalLeaf] ${result.engine} did not produce a PDF.`);
    }
  }

  if (!producedPdf && previousPdfPath && fs.existsSync(previousPdfPath)) {
    producedPdf = previousPdfPath;
    producedSynctex = previousSynctexPath && fs.existsSync(previousSynctexPath) ? previousSynctexPath : null;
    restoredPreviousPdf = true;
    logs.push("[LocalLeaf] Compile failed. Keeping the last successful PDF preview visible.");
  }
  if (projectLatexmkConfigSkipped) {
    logs.unshift("[LocalLeaf] Ignored project latexmkrc for safer local compilation. Set LOCALLEAF_ALLOW_LATEXMKRC=1 only if you fully trust the project.");
  }
  if (!producedPdf || restoredPreviousPdf) {
    cleanupCompileArtifact(artifactRoot);
  }

  const finalLogs = capCompilerLogs([
    ...logs,
    ...(producedPdf
      ? []
      : ["[LocalLeaf] Native PDF compile failed. Showing HTML preview fallback with the compiler log above."])
  ]);

  return {
    ok: Boolean(producedPdf) && producedOk && !restoredPreviousPdf,
    engine,
    mode: producedPdf ? "pdf" : "html",
    logs: finalLogs,
    previewHtml,
    pdfPath: producedPdf,
    synctexPath: producedSynctex,
    artifactRoot: restoredPreviousPdf ? previousArtifactRoot || null : producedPdf ? artifactRoot : null,
    sourceSnapshotRoot: restoredPreviousPdf
      ? previousSourceSnapshotRoot || null
      : producedPdf
        ? compileRoot
        : null,
    stale: restoredPreviousPdf
  };
}

module.exports = {
  buildCompilerArguments,
  buildCompilerEnvironment,
  capCompilerLogs,
  cleanupCompileArtifact,
  commandExists,
  compileProject,
  createCompileSnapshot,
  detectCompiler,
  expectedPdfPath,
  expectedSynctexPath,
  findBundledTectonic,
  findProjectLatexmkConfig,
  isValidPdfArtifact,
  normalizeProcessExitCode,
  readIncludedFiles,
  runProcess
};
