const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { renderLatexPreview } = require("./latex-preview");
const { listProjectFiles, resolveProjectPath } = require("./safe-path");

const ROOT = path.resolve(__dirname, "../..");
const PLATFORM_EXE = process.platform === "win32" ? ".exe" : "";

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
    if (file.type === "text" && file.path.endsWith(".tex")) {
      included.set(file.path, fs.readFileSync(resolveProjectPath(projectRoot, file.path), "utf8"));
    }
  }
  return included;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env
      }
    });

    let output = "";
    const timer = setTimeout(() => {
      output += "\n[LocalLeaf] Compile timed out and was stopped.\n";
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      options.onData?.(chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      options.onData?.(chunk.toString());
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${error.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function splitLogs(output) {
  return String(output || "").split(/\r?\n/).filter(Boolean);
}

function expectedPdfPath(projectRoot, mainFile, outputDir = projectRoot) {
  return path.join(outputDir, `${path.basename(mainFile, ".tex")}.pdf`);
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

async function runLatexmk(projectRoot, mainFile, outputDir, onData) {
  const result = await runProcess(
    "latexmk",
    ["-pdf", `-outdir=${outputDir}`, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", mainFile],
    {
      cwd: projectRoot,
      timeoutMs: 90000,
      onData
    }
  );

  return {
    engine: "latexmk",
    logs: splitLogs(result.output),
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir)
  };
}

async function runTectonic(projectRoot, mainFile, outputDir, command, onData) {
  const result = await runProcess(command, ["--synctex", "--outdir", outputDir, mainFile], {
    cwd: projectRoot,
    timeoutMs: 90000,
    onData
  });

  return {
    engine: command === "tectonic" ? "tectonic" : "bundled tectonic",
    logs: splitLogs(result.output),
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir)
  };
}

async function runDirectEngine(projectRoot, mainFile, source, outputDir, engine, onData) {
  const logs = [];
  const latexArgs = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1", `-output-directory=${outputDir}`, mainFile];

  for (let pass = 1; pass <= 2; pass += 1) {
    logs.push(`[LocalLeaf] ${engine} pass ${pass} started.`);
    const result = await runProcess(engine, latexArgs, {
      cwd: projectRoot,
      timeoutMs: 90000,
      onData
    });
    logs.push(...splitLogs(result.output));

    if (pass === 1 && hasBibliography(projectRoot, source) && commandExists("bibtex")) {
      const auxName = path.join(outputDir, path.basename(mainFile, ".tex"));
      logs.push("[LocalLeaf] BibTeX pass started.");
      const bibtex = await runProcess("bibtex", [auxName], {
        cwd: projectRoot,
        timeoutMs: 60000,
        onData
      });
      logs.push(...splitLogs(bibtex.output));
    }
  }

  return {
    engine,
    logs,
    pdfPath: expectedPdfPath(projectRoot, mainFile, outputDir)
  };
}

async function compileProject(projectRoot, mainFile, onData, options = {}) {
  const compiler = detectCompiler();
  const mainFilePath = resolveProjectPath(projectRoot, mainFile);
  const source = fs.readFileSync(mainFilePath, "utf8");
  const includedFiles = readIncludedFiles(projectRoot);
  const previewHtml = renderLatexPreview(source, includedFiles);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-compile-"));
  const previousPdfPath = options.previousPdfPath;
  let restoredPreviousPdf = false;

  if (!compiler.available) {
    const forced = process.env.LOCALLEAF_FORCE_PREVIEW === "1";
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
      pdfPath: null
    };
  }

  const attempts = [];
  const hasProjectLatexmkConfig = commandExists("latexmk") && fs.existsSync(path.join(projectRoot, "latexmkrc"));
  if (hasProjectLatexmkConfig) {
    attempts.push(() => runLatexmk(projectRoot, mainFile, outputDir, onData));
  }

  if (compiler.engine === "latexmk") {
    if (!hasProjectLatexmkConfig) attempts.push(() => runLatexmk(projectRoot, mainFile, outputDir, onData));
    const tectonic = findTectonic();
    if (tectonic) attempts.push(() => runTectonic(projectRoot, mainFile, outputDir, tectonic.command, onData));
    const direct = preferredDirectEngine(projectRoot, source);
    if (direct) attempts.push(() => runDirectEngine(projectRoot, mainFile, source, outputDir, direct, onData));
  } else if (compiler.engine === "tectonic") {
    attempts.push(() => runTectonic(projectRoot, mainFile, outputDir, compiler.command || "tectonic", onData));
    if (commandExists("latexmk") && !hasProjectLatexmkConfig) attempts.push(() => runLatexmk(projectRoot, mainFile, outputDir, onData));
    const direct = preferredDirectEngine(projectRoot, source);
    if (direct) attempts.push(() => runDirectEngine(projectRoot, mainFile, source, outputDir, direct, onData));
  } else {
    attempts.push(() => runDirectEngine(projectRoot, mainFile, source, outputDir, compiler.command || compiler.engine, onData));
  }

  const logs = [];
  let engine = compiler.engine;
  let producedPdf = null;

  for (const attempt of attempts) {
    const result = await attempt();
    engine = result.engine;
    logs.push(`[LocalLeaf] Trying ${result.engine}.`);
    logs.push(...result.logs);

    if (fs.existsSync(result.pdfPath)) {
      producedPdf = result.pdfPath;
      break;
    }

    logs.push(`[LocalLeaf] ${result.engine} did not produce a PDF.`);
  }

  if (!producedPdf && previousPdfPath && fs.existsSync(previousPdfPath)) {
    producedPdf = previousPdfPath;
    restoredPreviousPdf = true;
    logs.push("[LocalLeaf] Compile failed. Keeping the last successful PDF preview visible.");
  }

  return {
    ok: Boolean(producedPdf) && !restoredPreviousPdf,
    engine,
    mode: producedPdf ? "pdf" : "html",
    logs: [
      ...logs,
      ...(producedPdf
        ? []
        : ["[LocalLeaf] Native PDF compile failed. Showing HTML preview fallback with the compiler log above."])
    ],
    previewHtml,
    pdfPath: producedPdf
  };
}

module.exports = {
  commandExists,
  compileProject,
  detectCompiler,
  findBundledTectonic
};
