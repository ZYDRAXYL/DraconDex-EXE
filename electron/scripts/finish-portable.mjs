// Post-build step for `npm run build:portable` (dir target).
// electron-builder leaves the app at DraconDexPortable/win-unpacked; rename it
// to DraconDex-<version> so the folder users copy to a flash drive is
// self-describing, then print the final size and usage notes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// electron/scripts/finish-portable.mjs -> repo root is three levels up.
const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const outDir = path.join(root, 'DraconDexPortable');
const unpacked = path.join(outDir, 'win-unpacked');
const target = path.join(outDir, `DraconDex-${version}`);

if (!fs.existsSync(unpacked)) {
  console.error(`finish-portable: ${unpacked} not found — did "electron-builder --win dir" succeed?`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(unpacked, target);

// Marker read by main.js at startup: with it, data lives in
// novel-manager-data next to the exe (travels with the folder); without it
// (installed build), data goes to the per-user appData dir instead.
fs.writeFileSync(
  path.join(target, 'portable.flag'),
  'Portable marker for DraconDex. Keep this file next to DraconDex.exe so your data stays in this folder.\n'
);

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
const mb = (dirSize(target) / (1024 * 1024)).toFixed(0);

console.log('');
console.log(`Portable app folder ready: ${target} (${mb} MB)`);
console.log('');
console.log('How to use:');
console.log(`  1. Copy the whole "DraconDex-${version}" folder to your flash drive.`);
console.log('  2. On any Windows PC, open the folder and run DraconDex.exe.');
console.log('  3. Your data is stored in "novel-manager-data" next to the exe,');
console.log('     so it travels with the folder.');
