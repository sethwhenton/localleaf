const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
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

async function downloadFile(url, targetPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "LocalLeaf-release-build" },
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });
  if (!response.ok || !response.body) {
    throw new Error(`Electron download failed with HTTP ${response.status}: ${response.url || url}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));
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
