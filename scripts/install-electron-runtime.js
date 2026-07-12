const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const extract = require("extract-zip");

const electronDirectory = path.dirname(require.resolve("electron/package.json"));
const electronPackage = require(path.join(electronDirectory, "package.json"));
const electronChecksums = require(path.join(electronDirectory, "checksums.json"));
const distDirectory = path.join(electronDirectory, "dist");
const pathFile = path.join(electronDirectory, "path.txt");

function executableName(platform) {
  if (platform === "darwin" || platform === "mas") {
    return "Electron.app/Contents/MacOS/Electron";
  }
  if (platform === "win32") return "electron.exe";
  if (["linux", "freebsd", "openbsd"].includes(platform)) return "electron";
  throw new Error(`Electron does not publish a runtime for ${platform}`);
}

function runtimeIsReady(platformPath) {
  try {
    const installedVersion = fs.readFileSync(path.join(distDirectory, "version"), "utf8").replace(/^v/, "");
    const installedPath = fs.readFileSync(pathFile, "utf8");
    return (
      installedVersion === electronPackage.version &&
      installedPath === platformPath &&
      fs.existsSync(path.join(distDirectory, platformPath))
    );
  } catch {
    return false;
  }
}

const directHttpsAgent = new https.Agent({ keepAlive: true });

function downloadHttps(url, targetPath, signal, redirects = 0) {
  if (redirects > 8) {
    return Promise.reject(new Error("Electron download exceeded the redirect limit"));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: directHttpsAgent,
        signal,
        headers: { "user-agent": "LocalLeaf-release-build" }
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          resolve(downloadHttps(new URL(response.headers.location, url).toString(), targetPath, signal, redirects + 1));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Electron download failed with HTTP ${response.statusCode}: ${url}`));
          return;
        }

        const output = fs.createWriteStream(targetPath);
        response.setTimeout(2 * 60 * 1000, () => {
          response.destroy(new Error("Electron download stalled"));
        });
        response.on("error", reject);
        output.on("error", (error) => {
          response.destroy(error);
          reject(error);
        });
        output.on("finish", () => output.close(resolve));
        response.pipe(output);
      }
    );
    request.setTimeout(2 * 60 * 1000, () => request.destroy(new Error("Electron download request timed out")));
    request.on("error", reject);
  });
}

async function downloadFile(url, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Electron download exceeded five minutes")), 5 * 60 * 1000);
  try {
    await downloadHttps(url, targetPath, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function installElectronRuntime() {
  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;

  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const platformPath = executableName(platform);
  if (runtimeIsReady(platformPath)) {
    console.log(`Electron ${electronPackage.version} runtime is already installed for ${platform}-${arch}.`);
    return;
  }

  const assetPlatform = platform === "mas" ? "darwin" : platform;
  const assetName = `electron-v${electronPackage.version}-${assetPlatform}-${arch}.zip`;
  const expectedSha256 = electronChecksums[assetName];
  if (!expectedSha256) {
    throw new Error(`Electron checksum manifest has no entry for ${assetName}`);
  }

  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "localleaf-electron-"));
  const archivePath = path.join(tempDirectory, assetName);
  try {
    const url = `https://github.com/electron/electron/releases/download/v${electronPackage.version}/${assetName}`;
    console.log(`Downloading ${assetName}...`);
    await downloadFile(url, archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Electron checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }

    await fsp.rm(distDirectory, { recursive: true, force: true });
    await fsp.mkdir(distDirectory, { recursive: true });
    await extract(archivePath, { dir: distDirectory });
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true });
  }

  // The package already ships its matching declarations at the package root.
  await fsp.rm(path.join(distDirectory, "electron.d.ts"), { force: true });
  await fsp.writeFile(pathFile, platformPath, "utf8");

  if (!runtimeIsReady(platformPath)) {
    throw new Error(`Electron ${electronPackage.version} runtime verification failed for ${platform}-${arch}`);
  }
  if (platform !== "win32") {
    await fsp.chmod(path.join(distDirectory, platformPath), 0o755);
  }
  console.log(`Installed and verified Electron ${electronPackage.version} for ${platform}-${arch}.`);
}

// A pending Promise alone does not keep Node alive before the downloader has
// opened its first socket. Hold one referenced timer until installation settles.
const keepAlive = setInterval(() => {}, 1000);
installElectronRuntime()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
