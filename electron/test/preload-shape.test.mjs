// preload.js is one object literal handed to contextBridge — and in an object
// literal a repeated key does not merge, it REPLACES. Two `history:` blocks
// did exactly that: the second (bytesUsed/clear*) erased undo/redo, and the
// Ctrl+Z / Ctrl+Y shortcut threw on an undefined function. Found building the
// PWA, whose esbuild step warns on duplicate keys; nothing here did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'preload.js'), 'utf8');

test('no namespace appears twice in the api object', () => {
  const seen = new Map();
  const dupes = [];
  src.split('\n').forEach((line, i) => {
    const m = /^ {2}([A-Za-z_$][\w$]*):\s*\{/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) dupes.push(`${m[1]} (lines ${seen.get(m[1])} and ${i + 1})`);
    else seen.set(m[1], i + 1);
  });
  assert.deepEqual(dupes, []);
});

test('api.history carries undo and redo alongside the history-size calls', () => {
  const w = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (k, v) => { w[k] = v; } },
    ipcRenderer: { invoke: () => {}, on: () => {}, send: () => {}, removeListener: () => {} },
    webUtils: { getPathForFile: () => '' },
  };
  new Function('require', src)(() => electron);
  for (const fn of ['undo', 'redo', 'bytesUsed', 'clearModule', 'clearNexus', 'clearAll']) {
    assert.equal(typeof w.api.history[fn], 'function', `api.history.${fn}`);
  }
});
