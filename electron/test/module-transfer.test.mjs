import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// These tests match source text with regexes anchored on `\n`. `.gitattributes`
// says `* text=auto`, so a Windows checkout (the CI runner) has CRLF endings and
// those anchors stop matching — read every source through here instead.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// src/db/sync.js's applySnapshotCore is shared by applySnapshot (whole-nexus
// wipe-and-rebuild, Token Sync pull) and importModuleSnapshot (module-subtree
// merge-in, Setting window -> Appdata -> Database). The one thing that must
// never regress: a module-level import must never wipe the target nexus's
// existing content — that guard is what tells the two callers apart.
test('module-subtree import never wipes the nexus (only applySnapshot does)', () => {
  const src = readSource('../src/db/sync.js');

  const core = src.match(/function applySnapshotCore\([\s\S]*?\n\}\n/)?.[0] || '';
  assert.ok(core, 'applySnapshotCore not found');

  // The wipe (DELETE FROM module/entity_relation/note/note_folder/wiki_link)
  // must be gated behind `if (wipe)`.
  const wipeBlockMatch = core.match(/if \(wipe\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(wipeBlockMatch, 'wipe step is not gated behind `if (wipe)`');
  const wipeBlock = wipeBlockMatch[1];
  for (const table of ['module', 'entity_relation', 'note', 'note_folder', 'wiki_link']) {
    assert.match(wipeBlock, new RegExp(`DELETE FROM ${table}\\b`), `${table} DELETE must be inside the wipe gate`);
  }

  // applySnapshot (whole-nexus) must wipe; importModuleSnapshot must not.
  const applySnapshotFn = src.match(/function applySnapshot\(nexusId, payload\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(applySnapshotFn, /wipe:\s*true/, 'applySnapshot must wipe the whole nexus');

  const importModuleFn = src.match(/function importModuleSnapshot\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(importModuleFn, /wipe:\s*false/, 'importModuleSnapshot must be additive, never wipe');
  assert.match(importModuleFn, /updateNexusMeta:\s*false/, 'importModuleSnapshot must not touch the target nexus\'s own memo/color');

  // collectModuleSubtreeIds is the scoping helper exportModuleFile depends on.
  assert.match(src, /function collectModuleSubtreeIds\(nexusId, moduleId\)/);
  assert.match(src, /collectModuleSubtreeIds,\s*importModuleSnapshot/, 'both must be exported for db-transfer.js to use');
});
