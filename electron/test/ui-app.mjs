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
  // Procress 25: New opens the Create Nexus window (a child of Welcome); its
  // Create opens the vault's window. The first Nexus gets App Docs (the Guide
  // folder) by default — the suites lean on it.
  const [create] = await Promise.all([app.waitForEvent('window', { timeout: 20000 }),
    win.locator("button.btn-p[onclick='welcomeCreateNexus()']").first().click()]);
  await create.waitForSelector('#cn-grid .home-tpl', { timeout: 20000 });
  await create.fill('#nx-name', name);
  [win] = await Promise.all([app.waitForEvent('window', { timeout: 20000 }), create.click('#cn-create').catch(() => {})]); // the page closes under the click
  await win.waitForSelector('#hub-body', { timeout: 20000 });
  await win.waitForFunction(() => 'pendingCreate' in S, null, { timeout: 20000 });
  await win.evaluate(() => S.pendingCreate); // the Guide folder, made by the new window at boot
  await win.locator("button:has-text('Skip')").first().click({ timeout: 3000 }).catch(() => {}); // the Nest tour
  // The suites assert a desktop layout: 100% UI Size and a window wide enough
  // for the docked Properties panel (layout.css floats it under 1100 px).
  // Neither may depend on the machine's screen — autoUiSizeFromScreen() picks
  // 80% on the 1024-px display of a windows-latest runner, and the OS shrinks
  // the 1280-px window to fit it. Pin both, so the suites test the app rather
  // than the monitor they happen to run on.
  await win.setViewportSize({ width: 1280, height: 800 });
  await win.evaluate(() => setUiSetting('size', 100));
  await win.waitForTimeout(300);
  return {
    app, win,
    close: async () => { await app.close().catch(() => {}); rmSync(dataDir, { recursive: true, force: true }); },
  };
}
