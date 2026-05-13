const fs = require("node:fs");
const crypto = require("node:crypto");
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

const RELEASES = {
  tectonic: {
    repo: "tectonic-typesetting/tectonic",
    tag: "tectonic@0.16.9"
  },
  cloudflared: {
    repo: "cloudflare/cloudflared",
    tag: "2026.3.0"
  }
};

const TARGETS = {
  "darwin:arm64": {
    tectonic: {
      assetName: "tectonic-0.16.9-aarch64-apple-darwin.tar.gz",
      sha256: "edb67c61aba768289f6da441c9e6f523cfaff4f8b2a5708523ef29c543f8e88e",
      outputName: "tectonic",
      executableName: "tectonic"
    },
    cloudflared: {
      assetName: "cloudflared-darwin-arm64.tgz",
      sha256: "2aae4f69b0fc1c671b8353b4f594cbd902cd1e360c8eed2b8cad4602cb1546fb",
      outputName: "cloudflared",
      executableName: "cloudflared"
    }
  },
  "darwin:x64": {
    tectonic: {
      assetName: "tectonic-0.16.9-x86_64-apple-darwin.tar.gz",
      sha256: "79d8839fa3594bfea9b2bf2ac0a0455bcc4d0de956a5e5c403107e9a72f79e86",
      outputName: "tectonic",
      executableName: "tectonic"
    },
    cloudflared: {
      assetName: "cloudflared-darwin-amd64.tgz",
      sha256: "0f30140c4a5e213d22f951ef4c964cac5fb6a5f061ba6eba5ea932999f7c0394",
      outputName: "cloudflared",
      executableName: "cloudflared"
    }
  },
  "win32:x64": {
    tectonic: {
      assetName: "tectonic-0.16.9-x86_64-pc-windows-msvc.zip",
      sha256: "131a24604785a9600989a3d91225f597df52ac06f00aeffe86fd529f99ee5cdd",
      outputName: "tectonic.exe",
      executableName: "tectonic.exe"
    },
    cloudflared: {
      assetName: "cloudflared-windows-amd64.exe",
      sha256: "59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885",
      outputName: "cloudflared.exe",
      executableName: "cloudflared.exe"
    }
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

function findAsset(release, assetName) {
  const asset = release.assets.find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`Could not find release asset ${assetName}`);
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

function verifySha256(filePath, expected) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
  }
}

async function installAsset({ releaseRepo, releaseTag, assetName, sha256, outputName, executableName }) {
  const release = await requestJson(`https://api.github.com/repos/${releaseRepo}/releases/tags/${encodeURIComponent(releaseTag)}`);
  const asset = findAsset(release, assetName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localleaf-bin-"));
  const downloadPath = path.join(tempRoot, asset.name);
  const outputPath = path.join(BIN_DIR, outputName);

  console.log(`Downloading ${asset.name}`);
  await download(asset.browser_download_url, downloadPath);
  verifySha256(downloadPath, sha256);

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
    releaseRepo: RELEASES.tectonic.repo,
    releaseTag: RELEASES.tectonic.tag,
    ...target.tectonic
  });
  await installAsset({
    releaseRepo: RELEASES.cloudflared.repo,
    releaseTag: RELEASES.cloudflared.tag,
    ...target.cloudflared
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
