import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Windows checkouts have CRLF endings (`.gitattributes` uses `* text=auto`), which
// breaks source regexes anchored on `\n` — normalize before matching.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Procress 25: a Nexus is created in the Create Nexus window (core/nexus-create.js).
// App Docs and the tour are two choices there — the tour only with App Docs —
// and both reach the new vault's window as pending work, not a nested confirm.
test('Create Nexus offers App Docs and the tour inline, tour gated on App Docs', () => {
  const create = readSource('../src/renderer/core/nexus-create.js');
  const welcome = readSource('../src/renderer/core/welcome.js');
  const boot = readSource('../src/renderer/core/boot.js');
  const welcomeCreateNexus = welcome.match(/async function welcomeCreateNexus\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.doesNotMatch(welcomeCreateNexus, /uiConfirm\(/);
  assert.match(welcomeCreateNexus, /openCreateNexusWindow\(\)/);
  assert.match(create, /id="cn-appdocs"/);
  assert.match(create, /id="cn-tour"/);
  assert.match(create, /tour: appDocs && !!q\('#cn-tour'\)\?\.checked/);
  assert.match(create, /tour\.disabled = !docs\.checked/);
  // the new window does the work, once
  assert.match(boot, /runPendingCreate\(\)/);
  assert.match(create, /localStorage\.removeItem\(NEXUS_PENDING_GUIDE_KEY\)[\s\S]*api\.bundle\.create/);
});

test('a template that fails keeps the Nexus and offers the picker again', () => {
  const create = readSource('../src/renderer/core/nexus-create.js');
  const body = create.match(/async function runPendingCreate\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(body, /toastAction\(t\('cnTemplateFailed'\), t\('cnRetry'\), \(\) => openBundlePicker\(/);
  assert.doesNotMatch(body, /nexus\.delete/);
});

test('the Create Nexus window reports through exactly two new window channels', () => {
  const preload = readSource('../preload.js');
  const main = readSource('../main.js');
  for (const ch of ['window:openCreateNexus', 'window:createNexusDone']) {
    assert.match(preload, new RegExp(`inv\\('${ch}'`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}'`));
  }
  // only the create window itself may report, and it is hardened like the rest
  assert.match(main, /child\.id !== createNexusWinId/);
  assert.match(main, /function createNexusCreateWindow[\s\S]*?hardenWebviewAttach\(win\.webContents\)/);
  assert.match(main, /modal: process\.platform !== 'darwin'/);
});
