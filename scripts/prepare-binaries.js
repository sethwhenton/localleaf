const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const AdmZip = require("adm-zip");

const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "bin");
const platform = process.env.LOCALLEAF_TARGET_PLATFORM || process.platform;
const arch = process.env.LOCALLEAF_TARGET_ARCH || process.arch;
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const TARGETS = {
  "darwin:arm64": {
    tectonic: /aarch64-apple-darwin\.tar\.gz$/,
    cloudflared: /^cloudflared-darwin-arm64\.tgz$/,
    names: { tectonic: "tectonic", cloudflared: "cloudflared" }
  },
  "darwin:x64": {
    tectonic: /x86_64-apple-darwin\.tar\.gz$/,
    cloudflared: /^cloudflared-darwin-amd64\.tgz$/,
    names: { tectonic: "tectonic", cloudflared: "cloudflared" }
  },
  "win32:x64": {
    tectonic: /x86_64-pc-windows-msvc\.zip$/,
    cloudflared: /^cloudflared-windows-amd64\.exe$/,
    names: { tectonic: "tectonic.exe", cloudflared: "cloudflared.exe" }
  }
};

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { "user-agent": "LocalLeaf-build" };
    if (githubToken) {
      headers.authorization = `Bearer ${githubToken}`;
    }

    https
      .get(url, { headers }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          requestJson(response.headers.location).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Request failed ${response.statusCode}: ${url}`));
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(target);
    const headers = { "user-agent": "LocalLeaf-build" };
    if (githubToken) {
      headers.authorization = `Bearer ${githubToken}`;
    }

    https
      .get(url, { headers }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          file.close();
          fs.rmSync(target, { force: true });
          download(response.headers.location, target).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.rmSync(target, { force: true });
          reject(new Error(`Download failed ${response.statusCode}: ${url}`));
          response.resume();
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (error) => {
        file.close();
        fs.rmSync(target, { force: true });
        reject(error);
      });
  });
}

function findAsset(release, pattern) {
  const asset = release.assets.find((item) => pattern.test(item.name));
  if (!asset) {
    throw new Error(`Could not find release asset matching ${pattern}`);
  }
  return asset;
}

function findFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

function extractArchive(archivePath, extractRoot) {
  fs.mkdirSync(extractRoot, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    new AdmZip(archivePath).extractAllTo(extractRoot, true);
    return;
  }

  const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractRoot], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status}`);
  }
}

async function installAsset({ releaseRepo, pattern, outputName, executableName }) {
  const release = await requestJson(`https://api.github.com/repos/${releaseRepo}/releases/latest`);
  const asset = findAsset(release, pattern);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-bin-"));
  const downloadPath = path.join(tempRoot, asset.name);
  const outputPath = path.join(BIN_DIR, outputName);

  console.log(`Downloading ${asset.name}`);
  await download(asset.browser_download_url, downloadPath);

  if (asset.name.endsWith(".exe")) {
    fs.copyFileSync(downloadPath, outputPath);
  } else {
    const extractRoot = path.join(tempRoot, "extract");
    extractArchive(downloadPath, extractRoot);
    const binary = findFile(extractRoot, executableName);
    if (!binary) {
      throw new Error(`${asset.name} did not contain ${executableName}`);
    }
    fs.copyFileSync(binary, outputPath);
  }

  if (platform !== "win32") {
    fs.chmodSync(outputPath, 0o755);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Installed ${outputPath}`);
}

async function main() {
  const target = TARGETS[`${platform}:${arch}`];
  if (!target) {
    throw new Error(`No bundled binary recipe for ${platform}:${arch}`);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  await installAsset({
    releaseRepo: "tectonic-typesetting/tectonic",
    pattern: target.tectonic,
    outputName: target.names.tectonic,
    executableName: target.names.tectonic
  });
  await installAsset({
    releaseRepo: "cloudflare/cloudflared",
    pattern: target.cloudflared,
    outputName: target.names.cloudflared,
    executableName: target.names.cloudflared
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
