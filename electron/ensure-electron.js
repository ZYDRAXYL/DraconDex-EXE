const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sanitizePath(input) {
  return String(input || '')
    .replace(/["']/g, '')
    .replace(/[\r\n]/g, '')
    .trim();
}

function getElectronExecutableName() {
  return process.platform === 'win32' ? 'electron.exe' : 'electron';
}

// node_modules lives at the repo root, one level above this file's electron/ dir.
function getElectronPackagePath() {
  return path.join(__dirname, '..', 'node_modules', 'electron');
}

function getFallbackElectronPath() {
  return path.join(getElectronPackagePath(), 'dist', getElectronExecutableName());
}

function resolveElectronBinary() {
  const fallback = getFallbackElectronPath();

  if (fs.existsSync(fallback)) return fallback;

  try {
    const electron = require('electron');
    let resolved = null;
    if (typeof electron === 'string') resolved = electron;
    else if (electron && electron.path) resolved = electron.path;
    if (resolved) {
      const cleaned = path.normalize(sanitizePath(resolved));
      if (fs.existsSync(cleaned)) return cleaned;
    }
  } catch (error) {
    // Fall through to the local dist path.
  }

  return fallback;
}

function hasValidElectronInstall() {
  const electronPackagePath = getElectronPackagePath();
  const pathFile = path.join(electronPackagePath, 'path.txt');
  const binaryPath = resolveElectronBinary();

  if (!fs.existsSync(pathFile)) return false;
  if (!fs.existsSync(binaryPath)) return false;

  const pathFileValue = sanitizePath(fs.readFileSync(pathFile, 'utf8'));
  return pathFileValue === getElectronExecutableName();
}

function repairPathFileIfPossible() {
  const binaryPath = resolveElectronBinary();

  if (!fs.existsSync(binaryPath)) return false;

  fs.writeFileSync(path.join(getElectronPackagePath(), 'path.txt'), getElectronExecutableName());
  return true;
}

function runElectronInstall() {
  const installScript = path.join(getElectronPackagePath(), 'install.js');

  if (!fs.existsSync(installScript)) {
    throw new Error('Cannot find Electron install script. Run npm install first.');
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawnSync(process.execPath, [installScript], {
    env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron install script failed with exit code ${result.status}`);
  }
}

function ensureElectron() {
  if (hasValidElectronInstall()) return resolveElectronBinary();
  if (repairPathFileIfPossible() && hasValidElectronInstall()) return resolveElectronBinary();

  console.log('Electron binary is missing or incomplete. Reinstalling Electron...');
  runElectronInstall();
  if (repairPathFileIfPossible() && hasValidElectronInstall()) return resolveElectronBinary();

  if (!hasValidElectronInstall()) {
    throw new Error('Electron is still incomplete after reinstall. Delete node_modules/electron and run npm install.');
  }

  return resolveElectronBinary();
}

module.exports = {
  ensureElectron,
  resolveElectronBinary,
};

if (require.main === module) {
  // Runs as the `postinstall` hook. When this package is installed as a
  // dependency (`npm i @zydraxyl/dracondex`) electron is not there to install —
  // it is a devDependency of this repo, so it is not pulled in transitively.
  // Same for `npm ci --omit=dev` here. Failing the hook would fail the whole
  // install, so treat "no electron package at all" as nothing to repair; the
  // app itself still reports it properly via `npm start` (start.js).
  if (!fs.existsSync(getElectronPackagePath())) {
    console.log('Electron is not installed (dev dependency) — skipping the binary check.');
    process.exit(0);
  }
  try {
    console.log(ensureElectron());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
