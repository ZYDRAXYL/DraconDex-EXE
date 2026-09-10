#!/usr/bin/env node
// Batch driver for the DraconDex Electron app (agent tooling, not product code).
//
// Launches the app against an isolated scratch data dir (DRACONDEX_DATA_DIR),
// runs the commands given as argv, then quits. Each argv entry is one command:
//
//   node .claude/skills/run-dracondex/driver.mjs [--fresh] [--data-dir <path>] \
//     "ss nexus" "click .module-item" "wait 400" "ss director"
//
// Commands:
//   ss <name>              screenshot -> tmp-driver-data/shots/<name>.png
//   click <selector>       click first match (Playwright selector syntax)
//   dragto <src> :: <dst>  real HTML5 drag-and-drop from src to dst
//   fill <selector> :: <text>   set an input's value
//   type <text>            type into focused element
//   press <key>            keyboard key, e.g. Enter, Control+A
//   waitfor <selector>     wait for selector to be visible (10s timeout)
//   wait <ms>              sleep
//   text <selector>        print innerText of first match
//   count <selector>       print number of matches
//   eval <js>              run JS in the renderer, print JSON result
//   evalmain <js>          run JS in the Electron main process, print JSON result
// Flags:
//   --fresh                wipe the scratch data dir before launching
//   --data-dir <path>      scratch data dir (default: <repo>/tmp-driver-data)

import path from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require_ = createRequire(import.meta.url);
const { ensureElectron } = require_(path.join(root, 'electron', 'ensure-electron.js'));

// --- parse argv ---
const commands = [];
let dataDir = path.join(root, 'tmp-driver-data');
let fresh = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--fresh') fresh = true;
  else if (argv[i] === '--data-dir') dataDir = path.resolve(argv[++i]);
  else commands.push(argv[i]);
}
const shotsDir = path.join(dataDir, 'shots');

// "The renderer has painted something real." The first three cover Drake (the
// default chrome) and the Welcome window's own left panel; .wyvern-breadcrumb
// covers Wyvern and Dragon, which hide #left-panel entirely (css/workspace.css)
// — without it, driving a vault whose workspaceStyle isn't drake times out here.
// .welcome-wizard is the first-run setup wizard, which also runs with no left
// panel at all.
const READY_SELECTOR = '.module-item, #left-panel-inner .empty, #left-panel-inner .ph, #hub-body, .wyvern-breadcrumb, .welcome-wizard';

if (fresh && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });

const env = { ...process.env, DRACONDEX_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[driver] data dir: ${dataDir}`);
const app = await electron.launch({
  executablePath: ensureElectron(),
  args: [root],
  cwd: root,
  env,
});
// firstWindow() is the WELCOME window (v4.6.0): main.js opens that, not the
// app shell, and picking a vault there opens a second window and closes this
// one. So `win` is reassignable and the `nextwindow` command below follows the
// handoff — anything past "pick a vault" needs it.
let win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
// Renderer builds the UI at DOMContentLoaded; the vault picker (nexus items or
// its empty state), module tiles, or a populated Hub (#hub-body — the Nest
// tree may have real rows, not just the .empty state) are the ready signal.
await win.waitForSelector(READY_SELECTOR, { timeout: 15000 });
console.log('[driver] app ready');

let failed = false;
for (const raw of commands) {
  const sp = raw.indexOf(' ');
  const verb = sp === -1 ? raw : raw.slice(0, sp);
  const rest = sp === -1 ? '' : raw.slice(sp + 1).trim();
  try {
    switch (verb) {
      case 'ss': {
        const file = path.join(shotsDir, `${rest || 'shot'}.png`);
        await win.screenshot({ path: file });
        console.log(`[ss] ${file}`);
        break;
      }
      case 'click':
        await win.click(rest, { timeout: 5000 });
        console.log(`[click] ${rest}`);
        break;
      case 'dragto': {
        // Real HTML5 drag-and-drop via actual mouse.down/move/up (multiple
        // intermediate moves, like a human drag — not a synthetic
        // dispatchEvent and not Playwright's single-jump dragAndDrop helper)
        // — for verifying draggable="true" interactions actually work
        // end-to-end. Optional third segment picks the vertical fraction of
        // the target row to drop on (0=top edge, 0.5=center, 1=bottom edge)
        // to hit a specific drop zone; defaults to center.
        const [srcSel, dstSel, fracStr] = rest.split(' :: ').map(s => s.trim());
        const frac = fracStr !== undefined ? parseFloat(fracStr) : 0.5;
        const src = win.locator(srcSel).first();
        const dst = win.locator(dstSel).first();
        const srcBox = await src.boundingBox({ timeout: 5000 });
        if (!srcBox) throw new Error('dragto: source element not visible');
        const sx = srcBox.x + srcBox.width / 2, sy = srcBox.y + srcBox.height / 2;
        await win.mouse.move(sx, sy);
        // Re-measure the destination AFTER hovering the source — hovering a
        // row can reveal its .acts buttons and grow its height, shifting
        // rows below it, which would stale a box measured before this move.
        const dstBox = await dst.boundingBox({ timeout: 5000 });
        if (!dstBox) throw new Error('dragto: destination element not visible');
        const dx = dstBox.x + dstBox.width / 2, dy = dstBox.y + dstBox.height * frac;
        await win.mouse.down();
        await win.mouse.move(sx + (dx - sx) / 2, sy + (dy - sy) / 2, { steps: 5 });
        await win.mouse.move(dx, dy, { steps: 5 });
        await win.mouse.move(dx, dy, { steps: 2 }); // settle so dragover fires on the final target
        await win.mouse.up();
        console.log(`[dragto] ${srcSel} -> ${dstSel} @${frac}`);
        break;
      }
      case 'rclick': {
        // Real mouse-driven right-click (move + mouse.down/up button:'right')
        // so it fires a genuine browser `contextmenu` event -- not a synthetic
        // dispatchEvent -- for context-menu handlers wired via oncontextmenu=.
        const el = win.locator(rest).first();
        const box = await el.boundingBox({ timeout: 5000 });
        if (!box) throw new Error('rclick: element not visible');
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        await win.mouse.move(cx, cy);
        await win.mouse.down({ button: 'right' });
        await win.mouse.up({ button: 'right' });
        console.log(`[rclick] ${rest} @ ${cx},${cy}`);
        break;
      }
      case 'fill': {
        const [sel, text] = rest.split(' :: ');
        await win.fill(sel.trim(), text ?? '', { timeout: 5000 });
        console.log(`[fill] ${sel.trim()}`);
        break;
      }
      case 'upload': {
        // Real file-input upload (setInputFiles fires a genuine `change`
        // event) so FileReader-based handlers (e.g. the icon-crop uploader)
        // are exercised end-to-end, not bypassed with a synthetic value set.
        const [sel, filePath] = rest.split(' :: ').map(s => s.trim());
        await win.setInputFiles(sel, filePath, { timeout: 5000 });
        console.log(`[upload] ${sel} <- ${filePath}`);
        break;
      }
      case 'type':
        await win.keyboard.type(rest);
        console.log(`[type] ${rest}`);
        break;
      case 'press':
        await win.keyboard.press(rest);
        console.log(`[press] ${rest}`);
        break;
      case 'nextwindow': {
        // Point every later command at the app window that just opened (from
        // the Welcome screen, the vault-head switcher, or a popped-out tab).
        // Takes an already-open other window if there is one, otherwise waits
        // for the next 'window' event.
        const prev = win;
        const other = app.windows().find(w => w !== prev && !w.isClosed());
        win = other || await app.waitForEvent('window', { timeout: 15000 });
        await win.waitForLoadState('domcontentloaded');
        await win.waitForSelector(READY_SELECTOR, { timeout: 15000 });
        console.log(`[nextwindow] now driving ${await win.title()}`);
        break;
      }
      case 'waitfor':
        await win.waitForSelector(rest, { timeout: 10000 });
        console.log(`[waitfor] ${rest} visible`);
        break;
      case 'wait':
        await new Promise(r => setTimeout(r, parseInt(rest, 10) || 250));
        console.log(`[wait] ${rest}ms`);
        break;
      case 'text': {
        const t = await win.locator(rest).first().innerText({ timeout: 5000 });
        console.log(`[text] ${JSON.stringify(t)}`);
        break;
      }
      case 'count': {
        const n = await win.locator(rest).count();
        console.log(`[count] ${n}`);
        break;
      }
      case 'eval': {
        const result = await win.evaluate(rest);
        console.log(`[eval] ${JSON.stringify(result)}`);
        break;
      }
      case 'evalmain': {
        const result = await app.evaluate((electronMod, code) => {
          const { app, BrowserWindow, ipcMain } = electronMod;
          return eval(code);
        }, rest);
        console.log(`[evalmain] ${JSON.stringify(result)}`);
        break;
      }
      default:
        throw new Error(`unknown command: ${verb}`);
    }
  } catch (err) {
    console.error(`[FAIL] ${raw}\n${err.message}`);
    failed = true;
    try {
      await win.screenshot({ path: path.join(shotsDir, '_failure.png') });
      console.error(`[ss] ${path.join(shotsDir, '_failure.png')}`);
    } catch { /* window may be gone */ }
    break;
  }
}

await app.close();
process.exit(failed ? 1 : 0);
