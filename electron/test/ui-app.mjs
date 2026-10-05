// Shared launcher for the *.driver.mjs suites (ui-smoke, ui-audit): the real
// Electron app via Playwright, a throwaway data dir, the first-run wizard
// clicked through, and a fresh vault (which comes with the sample content).
// Not a test itself — the *.test.mjs glob skips it.
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ensureElectron } = createRequire(import.meta.url)(path.join(root, 'electron', 'ensure-electron.js'));
const READY = '.module-item, #left-panel-inner .empty, #left-panel-inner .ph, #hub-body, .wyvern-breadcrumb, .welcome-wizard';

export async function launchWithVault(name = 'Test') {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ddx-ui-'));
  const env = { ...process.env, DRACONDEX_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: ensureElectron(), args: [root], cwd: root, env });
  let win = await app.firstWindow();
  await win.waitForSelector(READY, { timeout: 20000 });
  await win.click('text=ENG - English');
  // Next until the last step (its Skip finishes), however many steps there are
  for (let i = 0; i < 10 && !(await win.locator("button.btn-g[onclick='welcomeWizardFinish()']").count()); i++) await win.click('button.btn-p[onclick^=welcomeWizardGo]');
  await win.click("button.btn-g[onclick='welcomeWizardFinish()']");
  await win.locator("button.btn-p[onclick='welcomeCreateNexus()']").first().click();
  await win.fill('#nx-name', name);
  await win.click("button.btn-p[onclick='createNexusSubmit()']");
  win = await app.waitForEvent('window', { timeout: 20000 });
  await win.waitForSelector('#hub-body', { timeout: 20000 });
  await win.locator("button:has-text('Skip')").first().click({ timeout: 3000 }).catch(() => {}); // the Nest tour
  return {
    app, win,
    close: async () => { await app.close().catch(() => {}); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
