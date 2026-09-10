const { spawnSync } = require('child_process');
const { ensureElectron } = require('./ensure-electron');

let electronPath;
try {
  electronPath = ensureElectron();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const args = process.argv.slice(2);


if (!args.length) args.push('.');


const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, args, {
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error('Failed to start Electron:', result.error);
  process.exit(1);
}

process.exit(result.status || 0);
