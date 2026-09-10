#!/usr/bin/env node
// DraconDex file-architecture checker (agent tooling).
//
// Usage (from repo root):
//   node .claude/skills/dracondex-file-arch/check-arch.mjs            # whole repo
//   node .claude/skills/dracondex-file-arch/check-arch.mjs electron/src/renderer/hub/tree.js
//
// Two halves:
//   SIZE / ORGANISATION — the Plan.md bands (0-500 / 500-1000 / 1000-2000 /
//     2000+ / 4000+) as *signals*, plus a responsibility signal and the folder
//     conventions. These produce notices and warnings, never errors: whether a
//     file has too many responsibilities is a judgement call, and this tool's
//     job is to put the evidence in front of you.
//   WIRING — the things a split can silently break. These ARE errors: an
//     unreferenced renderer file, a duplicated top-level binding, an unlinked
//     stylesheet, a db file nothing requires, a css url() that lost its ../,
//     a build that would ship without its CSS.
//
// Exit 1 on errors, 0 otherwise — same contract as dracondex-module-style.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

let errors = 0, warnings = 0;
const err = (m) => { errors++; console.log(`  ERROR   ${m}`); };
const warn = (m) => { warnings++; console.log(`  warning ${m}`); };
const note = (m) => console.log(`  note    ${m}`);
const ok = (m) => console.log(`  ok      ${m}`);

const argvFiles = process.argv.slice(2).map((f) => f.replace(/\\/g, '/'));

// ── what counts as app source ──────────────────────────────────────────────
// Every Electron path is relative to the repo root and therefore carries the
// APP_DIR prefix; the repo root itself holds only package/docs/tooling now.
const APP_DIR = 'electron';
const app = (f) => `${APP_DIR}/${f}`;
const SOURCE_ROOTS = [app('src'), app('css'), app('scripts')];
const ENTRY_FILES = ['main.js', 'preload.js', 'preload-plugin.js', 'database.js', 'start.js', 'ensure-electron.js', 'index.html'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'flutter', 'old_db_data', '.git']);

// Data files: long by nature, exempt from the size bands. Plan.md names this
// exemption explicitly ("เว้นแต่เป็นไฟล์ข้อมูล (เช่น i18n, constants)").
const DATA_FILES = new Set([
  app('src/renderer/i18n.js'),
  app('src/db/schema/ddl.js'),
  app('src/db/schema/indexes.js'),
  app('src/db/schema/seed.js'),
  app('css/themes.css'),
]);

const walk = (dir) => {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      if (SKIP_DIRS.has(e.name)) return [];
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return walk(rel);
      return /\.(js|mjs|css)$/.test(e.name) ? [rel] : [];
    });
};

const allSource = [...ENTRY_FILES.filter((f) => f.endsWith('.js') && existsSync(path.join(root, APP_DIR, f))).map(app),
                   ...SOURCE_ROOTS.flatMap(walk)];
const lineCount = (f) => read(f).split('\n').length - 1;

// ═══ 1. Size bands ══════════════════════════════════════════════════════════
// Bands straight out of Plan.md. They are a signal, not a rule: split when a
// file's *responsibilities* grow, not merely when it gets long.
const BANDS = [
  [500,  'ok'],
  [1000, 'check whether it has more than one job'],
  [2000, 'start considering a split'],
  [4000, 're-evaluate — this is doing too much'],
  [Infinity, 'split unless it is a data file'],
];
const bandOf = (n) => BANDS.find(([max]) => n < max);

console.log('=== size bands (Plan.md) ===');
{
  const targets = argvFiles.length ? argvFiles : allSource;
  const big = [];
  for (const f of targets) {
    if (!existsSync(path.join(root, f))) { err(`${f} does not exist`); continue; }
    const n = lineCount(f);
    if (DATA_FILES.has(f)) { if (n >= 500) note(`${f} — ${n} lines (data file, exempt)`); continue; }
    if (n >= 500) big.push([f, n]);
  }
  big.sort((a, b) => b[1] - a[1]);
  for (const [f, n] of big) {
    const [, advice] = bandOf(n);
    if (n >= 4000) err(`${f} — ${n} lines: ${advice}`);
    else if (n >= 2000) warn(`${f} — ${n} lines: ${advice}`);
    else note(`${f} — ${n} lines: ${advice}`);
  }
  if (!big.length) ok(`no non-data file over 500 lines (${targets.length} files checked)`);
}

// ═══ 2. Responsibility signal ═══════════════════════════════════════════════
// A long file that also carries many banner sections or many top-level
// declarations is the shape that splits well. Report the banners so the
// reviewer can see the seams instead of guessing.
console.log('=== responsibility signal (>500 lines) ===');
{
  const targets = (argvFiles.length ? argvFiles : allSource).filter((f) => f.endsWith('.js') && !DATA_FILES.has(f));
  let flagged = 0;
  for (const f of targets) {
    if (!existsSync(path.join(root, f))) continue;
    const src = read(f);
    const n = src.split('\n').length - 1;
    if (n <= 500) continue;
    const banners = [...src.matchAll(/^\s*(?:\/\/|\/\*)\s*═+\s*(.+?)\s*═/gm)].map((m) => m[1]);
    const decls = [...src.matchAll(/^(?:async\s+)?function\s+\w+|^(?:const|let|var)\s+\w+/gm)].length;
    if (banners.length >= 4 || decls >= 25) {
      flagged++;
      warn(`${f} — ${n} lines, ${decls} top-level declarations, ${banners.length} banner section(s)`);
      if (banners.length) note(`    seams: ${banners.slice(0, 8).join(' | ')}${banners.length > 8 ? ' …' : ''}`);
    }
  }
  if (!flagged) ok('no oversized file shows multiple-responsibility signals');
}

// ── the rest are repo-wide wiring checks; skip when linting single files ────
if (argvFiles.length) {
  console.log(`\n${errors} error(s), ${warnings} warning(s) — run with no arguments for the wiring checks`);
  process.exit(errors ? 1 : 0);
}

const indexSrc = read(app('index.html'));
const rendererFiles = walk(app('src/renderer'));
const dbFiles = walk(app('src/db'));
const cssFiles = walk(app('css'));

// ═══ 3. Folder conventions ══════════════════════════════════════════════════
console.log('=== folder conventions ===');
{
  const strayApp = readdirSync(path.join(root, APP_DIR), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|css)$/.test(e.name) && !ENTRY_FILES.includes(e.name));
  if (strayApp.length) warn(`loose source file(s) in ${APP_DIR}/: ${strayApp.map((e) => e.name).join(', ')} — app code belongs in ${app('src')}/ or ${app('css')}/`);
  else ok(`${APP_DIR}/ holds only the ${ENTRY_FILES.length} expected entry files`);

  const dbStray = dbFiles.filter((f) => !/^electron\/src\/db\/(schema\/)?[\w.-]+\.js$/.test(f));
  if (dbStray.length) warn(`db file(s) outside ${app('src/db')}/ or ${app('src/db/schema')}/: ${dbStray.join(', ')}`);
  else ok(`all ${dbFiles.length} db files sit in ${app('src/db')}/ or ${app('src/db/schema')}/`);

  // A renderer family that grew past one file should be a folder, not a
  // sprawl of foo-bar.js siblings.
  const hyphenated = rendererFiles.filter((f) => /\/[\w]+-[\w-]+\.js$/.test(f) && f.split('/').length === 4);
  if (hyphenated.length) note(`flat multi-word renderer file(s) — consider a folder: ${hyphenated.join(', ')}`);
}

// ═══ 4. Every renderer file is reachable ════════════════════════════════════
console.log('=== renderer files are loaded ===');
{
  const referenced = new Set();
  // index.html and loadModule() name paths relative to electron/; walk() yields
  // them relative to the repo root, so prefix before comparing.
  for (const m of indexSrc.matchAll(/<script src="([^"]+)"/g)) referenced.add(app(m[1]));
  // loadModule('src/renderer/x.js') and the LAZY_GROUPS template form
  // `src/renderer/navigator/${f}.js` — the latter names a whole folder.
  const folderRefs = new Set();
  for (const f of rendererFiles) {
    const src = read(f);
    for (const m of src.matchAll(/['"`]src\/renderer\/[\w/-]+\.js['"`]/g)) referenced.add(app(m[0].slice(1, -1)));
    for (const m of src.matchAll(/`src\/renderer\/([\w-]+)\/\$\{/g)) folderRefs.add(app(`src/renderer/${m[1]}`));
  }
  const orphans = rendererFiles.filter((f) =>
    !referenced.has(f) && !folderRefs.has(path.posix.dirname(f)));
  if (orphans.length) orphans.forEach((f) => err(`${f} is never loaded — no <script> tag in index.html and no loadModule()/LAZY_GROUPS reference`));
  else ok(`all ${rendererFiles.length} renderer files are loaded (eager tag, loadModule, or a LAZY_GROUPS folder)`);
}

// ═══ 5. No duplicate top-level bindings across renderer scripts ═════════════
// They share one global scope. A duplicated `const` throws at parse time and
// blanks the whole app; a duplicated `function` silently shadows.
console.log('=== duplicate global declarations (renderer) ===');
{
  const owners = new Map();
  for (const f of rendererFiles) {
    for (const m of read(f).matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm)) {
      const name = m[1] || m[2];
      (owners.get(name) ?? owners.set(name, []).get(name)).push(f);
    }
  }
  const dupes = [...owners].filter(([, fs]) => new Set(fs).size > 1);
  if (dupes.length) dupes.forEach(([n, fs]) => err(`'${n}' declared at top level in ${[...new Set(fs)].join(' and ')} — renderer scripts share one global scope`));
  else ok(`${owners.size} top-level names, each declared in exactly one file`);
}

// ═══ 6. Stylesheets ═════════════════════════════════════════════════════════
console.log('=== stylesheets ===');
{
  const linked = [...indexSrc.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => app(m[1]));
  const missing = cssFiles.filter((f) => !linked.includes(f));
  const dangling = linked.filter((f) => !existsSync(path.join(root, f)));
  if (missing.length) missing.forEach((f) => err(`${f} exists but index.html never links it`));
  if (dangling.length) dangling.forEach((f) => err(`index.html links ${f}, which does not exist`));
  if (!missing.length && !dangling.length) ok(`all ${cssFiles.length} stylesheets linked, in cascade order`);

  // url() resolves against the stylesheet, not the document: a rule moved out
  // of a root-level style.css into css/ needs '../'. This shipped as a real
  // 404 during the Plan part1 split.
  const badUrl = [];
  for (const f of cssFiles) {
    for (const m of read(f).matchAll(/url\(\s*['"]?(?!data:|https?:|\.\.\/|#)([^)'"]+)['"]?\s*\)/g)) {
      badUrl.push(`${f}: url('${m[1]}')`);
    }
  }
  if (badUrl.length) badUrl.forEach((u) => err(`${u} — relative to the stylesheet, so an asset outside ${app('css')}/ needs '../'`));
  else ok(`every relative url() in ${app('css')}/ resolves from the stylesheet, not from ${APP_DIR}/`);
}

// ═══ 7. Packaged build covers every source dir ══════════════════════════════
console.log('=== packaged build (package.json build.files) ===');
{
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build?.files ?? [];
  const needed = [app('index.html'), app('main.js'), app('preload.js'), app('database.js'),
                  app('src'), app('css'), 'src/assets/brand'];
  // build.files entries are globs ('electron/**/*') and exclusions ('!…/test/**').
  // Match on the literal prefix ahead of the first wildcard, in either
  // direction: a broad 'electron/**/*' covers a specific file, and a narrow
  // 'electron/css/**' still proves 'electron/css' ships.
  const covers = (pattern, target) => {
    if (pattern.startsWith('!')) return false;
    const prefix = pattern.split('*')[0].replace(/\/+$/, '');
    return prefix === '' || target === prefix ||
           target.startsWith(`${prefix}/`) || prefix.startsWith(`${target}/`);
  };
  const uncovered = needed.filter((n) => !files.some((f) => covers(f, n)));
  if (uncovered.length) uncovered.forEach((n) => err(`build.files does not ship '${n}' — the packaged app would be missing it`));
  else ok(`build.files covers all ${needed.length} required entries`);
}

// ═══ 8. Every db file is reachable from database.js ═════════════════════════
console.log('=== db files are required ===');
{
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel) || !existsSync(path.join(root, rel))) return;
    seen.add(rel);
    for (const m of read(rel).matchAll(/require\('(\.[^']+)'\)/g)) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!target.endsWith('.js')) target += '.js';
      visit(target);
    }
  };
  visit(app('database.js'));
  const unreached = dbFiles.filter((f) => !seen.has(f));
  if (unreached.length) unreached.forEach((f) => err(`${f} is never required from ${app('database.js')} (directly or transitively)`));
  else ok(`all ${dbFiles.length} db files are reachable from ${app('database.js')}`);
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
