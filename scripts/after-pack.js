const path = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const projectDir = context.packager.projectDir;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(projectDir, "build", "icon.ico");
  const rceditPath = path.join(projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

  const args = [
    exePath,
    "--set-icon",
    iconPath,
    "--set-version-string",
    "FileDescription",
    "LocalLeaf Host",
    "--set-version-string",
    "ProductName",
    "LocalLeaf Host",
    "--set-version-string",
    "InternalName",
    "LocalLeaf Host",
    "--set-version-string",
    "OriginalFilename",
    exeName
  ];

  const result = spawnSync(rceditPath, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`rcedit failed with exit code ${result.status}`);
  }
};
