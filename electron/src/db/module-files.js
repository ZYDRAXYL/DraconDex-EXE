'use strict';
// ═══ A module as two files: .ddata + .dpage (Procress 16 part 3a) ═══════
// APP Suggestion.md: split what a module KNOWS from how it is SHOWN.
//   <name>.ddata  the module's data — the v2 snapshot a .mddx carried
//                 (sync.js serializeVault), minus its page
//   <name>.dpage  the module's page — that snapshot's pageBlocks: the blocks,
//                 their layout, and what each component draws from
//                 (source_key = module_<id>, the module-to-module binding)
// One snapshot in two files: split on write, joined on read, so every reader
// goes through the one import a .mddx always took (importModuleSnapshot). The
// .ddx stays the source of truth (V5.md §8.1); these are what a person sees
// in the Locate folder and carries to another vault. A .mddx still imports.
// Format: APP docs/DATA-PAGE.md (and SDB schema/FILE-FORMATS.md).
const fs = require('fs');
const path = require('path');

const DATA_EXT = '.ddata';
const PAGE_EXT = '.dpage';
const FILE_VERSION = 1;

function splitSnapshot(snap) {
  const { pageBlocks = [], ...rest } = snap || {};
  return {
    data: { ...rest, file: 'ddata', fileVersion: FILE_VERSION, pageBlocks: [] },
    page: {
      file: 'dpage', fileVersion: FILE_VERSION, format: snap?.format ?? null,
      // which module(s) of the .ddata beside it these blocks belong to — informational
      modules: (snap?.modules || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
      pageBlocks,
    },
  };
}

const joinSnapshot = (data, page) => ({ ...data, pageBlocks: Array.isArray(page?.pageBlocks) ? page.pageBlocks : (data.pageBlocks || []) });

// Any module file → its snapshot. A .ddata or .dpage is read with its sibling
// of the same name; a .dpage alone has no data to land on, so it is refused.
function readModuleFile(filePath) {
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== DATA_EXT && ext !== PAGE_EXT) return read(filePath);
  const base = filePath.slice(0, -ext.length);
  const data = fs.existsSync(base + DATA_EXT) ? read(base + DATA_EXT) : null;
  if (!data) throw new Error('a .dpage needs the .ddata of the same name beside it');
  const page = fs.existsSync(base + PAGE_EXT) ? read(base + PAGE_EXT) : null;
  return joinSnapshot(data, page);
}

// basePath without an extension; writes <base>.ddata and <base>.dpage.
function writeModuleFiles(basePath, snap) {
  const { data, page } = splitSnapshot(snap);
  fs.writeFileSync(basePath + DATA_EXT, JSON.stringify(data));
  fs.writeFileSync(basePath + PAGE_EXT, JSON.stringify(page));
}

module.exports = { DATA_EXT, PAGE_EXT, FILE_VERSION, splitSnapshot, joinSnapshot, readModuleFile, writeModuleFiles };
