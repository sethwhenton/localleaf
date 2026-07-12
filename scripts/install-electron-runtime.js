const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

if (
  !process.env.ELECTRON_GET_USE_PROXY &&
  (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy)
) {
  process.env.ELECTRON_GET_USE_PROXY = "1";
}

const { downloadArtifact } = require("@electron/get");
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

async function installElectronRuntime() {
  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;

  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const platformPath = executableName(platform);
  if (runtimeIsReady(platformPath)) {
    console.log(`Electron ${electronPackage.version} runtime is already installed for ${platform}-${arch}.`);
    return;
  }

  const archivePath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform,
    arch,
    cacheRoot: process.env.electron_config_cache,
    checksums: electronChecksums
  });

  await fsp.rm(distDirectory, { recursive: true, force: true });
  await fsp.mkdir(distDirectory, { recursive: true });
  await extract(archivePath, { dir: distDirectory });

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
