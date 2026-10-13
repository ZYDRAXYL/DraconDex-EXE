// Procress 23 — "Use system glass" (experimental, off by default): the one
// main-side function that puts the OS material behind an app window. Driven
// with a fake window and an explicit platform, so it runs on any OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const { systemGlassMode, applySystemGlass, systemGlassApplied, SYSTEM_GLASS_KEY } = createRequire(import.meta.url)('../src/db/system-glass.js');

function fakeWin() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  return {
    calls,
    isDestroyed: () => false,
    setBackgroundMaterial: rec('setBackgroundMaterial'),
    setVibrancy: rec('setVibrancy'),
    setBackgroundColor: rec('setBackgroundColor'),
    webContents: { executeJavaScript: (js) => { calls.push(['executeJavaScript', js]); return Promise.resolve(); } },
  };
}
const WIN11 = { platform: 'win32', release: '10.0.22631' };
const WIN10 = { platform: 'win32', release: '10.0.19045' };
const MAC = { platform: 'darwin', release: '23.4.0' };
const LINUX = { platform: 'linux', release: '6.8.0' };
const names = (w) => w.calls.map((c) => c[0]);

test('the platform picks the call: acrylic on Windows 11, vibrancy on macOS, none elsewhere', () => {
  assert.equal(systemGlassMode(WIN11.platform, WIN11.release), 'acrylic');
  assert.equal(systemGlassMode(WIN10.platform, WIN10.release), null); // setBackgroundMaterial needs 22H2
  assert.equal(systemGlassMode(MAC.platform, MAC.release), 'vibrancy');
  assert.equal(systemGlassMode(LINUX.platform, LINUX.release), null);
});

test('Windows 11: on sets acrylic + a transparent window, off restores both', () => {
  const w = fakeWin();
  applySystemGlass(w, true, WIN11);
  assert.deepEqual(w.calls.slice(0, 2), [['setBackgroundMaterial', 'acrylic'], ['setBackgroundColor', '#00000000']]);
  assert.match(w.calls[2][1], /toggleAttribute\('data-system-glass', true\)/);
  assert.ok(!names(w).includes('setVibrancy'));
  assert.ok(systemGlassApplied(w));
  w.calls.length = 0;
  applySystemGlass(w, false, WIN11);
  assert.deepEqual(w.calls.slice(0, 2), [['setBackgroundMaterial', 'none'], ['setBackgroundColor', '#050506']]);
  assert.match(w.calls[2][1], /toggleAttribute\('data-system-glass', false\)/);
  assert.ok(!systemGlassApplied(w));
});

test('macOS: on sets under-window vibrancy, off clears it', () => {
  const w = fakeWin();
  applySystemGlass(w, true, MAC);
  assert.deepEqual(w.calls[0], ['setVibrancy', 'under-window']);
  assert.ok(!names(w).includes('setBackgroundMaterial'));
  w.calls.length = 0;
  applySystemGlass(w, false, MAC);
  assert.deepEqual(w.calls[0], ['setVibrancy', null]);
});

test('with the setting off, no call is made — on any platform', () => {
  for (const env of [WIN11, WIN10, MAC, LINUX]) {
    const w = fakeWin();
    applySystemGlass(w, false, env);
    assert.deepEqual(w.calls, [], env.platform);
  }
});

test('linux and Windows 10 never get a call, even turned on', () => {
  for (const env of [LINUX, WIN10]) {
    const w = fakeWin();
    applySystemGlass(w, true, env);
    assert.deepEqual(w.calls, [], env.release);
  }
});

test('applying the same value twice calls nothing the second time', () => {
  const w = fakeWin();
  applySystemGlass(w, true, MAC);
  w.calls.length = 0;
  applySystemGlass(w, true, MAC);
  assert.deepEqual(w.calls, []);
});

test('a destroyed window is left alone', () => {
  const w = { ...fakeWin(), isDestroyed: () => true };
  applySystemGlass(w, true, MAC);
  assert.deepEqual(w.calls, []);
});

// The wiring: main reaches it only through the existing setting:set door,
// whose allow-list names the key — no new IPC channel, no new preload entry.
test('main applies it from setting:set, and preload gains nothing', () => {
  const main = readFileSync(join(here, '..', 'main.js'), 'utf8');
  assert.equal(SYSTEM_GLASS_KEY, 'systemGlass');
  assert.match(main, /RENDERER_SETTING_KEYS = new Set\(\[[^\]]*'systemGlass'/);
  assert.match(main, /if \(k === db\.SYSTEM_GLASS_KEY\) syncSystemGlass\(\)/);
  assert.equal((main.match(/db\.applySystemGlass\(/g) || []).length, 1, 'one place in main');
  assert.doesNotMatch(readFileSync(join(here, '..', 'preload.js'), 'utf8'), /systemGlass|setBackgroundMaterial|setVibrancy/);
});
