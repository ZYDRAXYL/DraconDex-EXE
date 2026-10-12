'use strict';
// "Use system glass" (Procress 23, APP docs/UX-LAYOUT.md §15) — EXPERIMENTAL,
// off by default, and untested on real hardware: the OS's own material behind
// the Glass UI style instead of css/glass.css's gradient backdrop.
//
//   win32 (Windows 11 22H2+, build 22621)  win.setBackgroundMaterial('acrylic')
//   darwin                                 win.setVibrancy('under-window')
//   anything else (linux, Windows 10)      nothing — the CSS backdrop stays
//
// The renderer decides whether it is wanted (the setting is on, the UI style
// is glass, nothing asked for reduced transparency) and stores that as the
// app_setting `systemGlass` ('1' / '0') through the existing setting:set door;
// main.js then calls applySystemGlass() on every app window. This is the only
// place that touches a window's material.
//
// Turned on, the window's own background goes transparent and <html> gets
// data-system-glass, which css/glass.css uses to drop the #window-frame
// gradient so the material shows through. Turned off, all three are undone.
// A window that never had it gets no call at all.
const os = require('os');

const SYSTEM_GLASS_KEY = 'systemGlass';
// createWindow's backgroundColor — what an opaque window returns to.
const OPAQUE_BG = '#050506';
const MIN_WIN11_BUILD = 22621; // setBackgroundMaterial needs 22H2

// Which native call this platform gets, or null for none.
function systemGlassMode(platform = process.platform, release = os.release()) {
  if (platform === 'win32') {
    const build = Number(String(release).split('.')[2]);
    return Number.isFinite(build) && build >= MIN_WIN11_BUILD ? 'acrylic' : null;
  }
  if (platform === 'darwin') return 'vibrancy';
  return null;
}

// Windows that currently carry the material (by object, so a closed window
// simply drops out).
const applied = new WeakSet();

function applySystemGlass(win, on, env = {}) {
  const mode = systemGlassMode(env.platform, env.release);
  if (!mode || !win || win.isDestroyed?.()) return { mode, changed: false };
  on = !!on;
  if (on === applied.has(win)) return { mode, changed: false };
  if (mode === 'acrylic') {
    if (typeof win.setBackgroundMaterial !== 'function') return { mode, changed: false }; // Electron < 24
    win.setBackgroundMaterial(on ? 'acrylic' : 'none');
  } else {
    win.setVibrancy(on ? 'under-window' : null);
  }
  win.setBackgroundColor(on ? '#00000000' : OPAQUE_BG);
  // Executed once the page has loaded if it has not yet; a reload re-runs the
  // renderer's own sync, which lands here again only when the value changed —
  // so the attribute is also re-set from the window's did-finish-load (main.js).
  markSystemGlass(win, on);
  if (on) applied.add(win); else applied.delete(win);
  return { mode, changed: true };
}

function markSystemGlass(win, on) {
  win.webContents?.executeJavaScript?.(`document.documentElement.toggleAttribute('data-system-glass', ${on ? 'true' : 'false'})`)
    ?.catch?.(() => {});
}

function systemGlassApplied(win) { return applied.has(win); }

module.exports = { SYSTEM_GLASS_KEY, systemGlassMode, applySystemGlass, markSystemGlass, systemGlassApplied };
