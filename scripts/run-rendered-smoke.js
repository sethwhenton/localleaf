const path = require("node:path");
const { spawn } = require("node:child_process");

const electronPath = require("electron");
const root = path.resolve(__dirname, "..");
const entry = path.join(root, "tests", "electron", "rendered-smoke.js");
const timeoutMs = 75_000;
const useGitHubLinuxNoSandbox =
  process.platform === "linux" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.LOCALLEAF_RENDERED_SMOKE_NO_SANDBOX === "true";
const electronArgs = useGitHubLinuxNoSandbox ? ["--no-sandbox", entry] : [entry];

const child = spawn(electronPath, electronArgs, {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let outputTail = "";
let completed = false;
let failed = false;
let timedOut = false;

function observe(chunk, stream) {
  const text = chunk.toString("utf8");
  stream.write(text);
  outputTail = `${outputTail}${text}`.slice(-8192);
  completed ||= outputTail.includes("[rendered-smoke] COMPLETE");
  failed ||= outputTail.includes("[rendered-smoke] FAIL");
}

child.stdout.on("data", (chunk) => observe(chunk, process.stdout));
child.stderr.on("data", (chunk) => observe(chunk, process.stderr));

const timeout = setTimeout(() => {
  timedOut = true;
  failed = true;
  process.stderr.write(`[rendered-smoke] FAIL runner exceeded its ${timeoutMs}ms deadline.\n`);
  child.kill("SIGKILL");
}, timeoutMs);

child.on("error", (error) => {
  clearTimeout(timeout);
  process.stderr.write(`[rendered-smoke] FAIL Electron could not start: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  clearTimeout(timeout);
  if (!completed || failed || timedOut || code !== 0) {
    if (!failed) {
      process.stderr.write(`[rendered-smoke] FAIL Electron exited before completing the gate${signal ? ` (${signal})` : ""}.\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
});
