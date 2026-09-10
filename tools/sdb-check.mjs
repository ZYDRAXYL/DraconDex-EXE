// Verify this repo's vendored DraconDex-SDB artifacts against the version it pins.
//
//   node tools/sdb-check.mjs            local + remote
//   node tools/sdb-check.mjs --local    skip the network entirely
//
// Before the multi-repo split, `generate.mjs --check` guaranteed that the
// committed schema output matched vault.sql — it could, because everything was
// in one checkout. It cannot any more: vault.sql lives in DraconDex-SDB and the
// generated output is vendored here. This restores the same guarantee across
// the boundary.
//
// Two failure modes matter and are easy to forget:
//   * a vendored file was hand-edited here   -> the LOCAL phase catches it
//   * SDB started publishing something new   -> the REMOTE phase catches it
// The second is the one a naive "do the hashes match" check misses entirely.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'sdb.lock.json'))) return d;
    const up = dirname(d); if (up === d) break; d = up;
  }
  throw new Error('sdb.lock.json not found — this repo does not vendor DraconDex-SDB');
})();
const LOCAL_ONLY = process.argv.includes('--local');

// Must match SDB's tools/build-manifest.mjs exactly. `.gitattributes` is
// `* text=auto`, so a Windows checkout rewrites every text file's line endings
// on the way to disk; hashing raw bytes would redden every Windows CI run for
// a difference that is not real.
const normalizeEol = s => s.replace(/\r\n/g, '\n');
const isText = p => /\.(js|dart|sql|json|md|mjs|txt)$/.test(p);
const hash = (abs, rel) => {
  const buf = readFileSync(abs);
  const data = isText(rel) ? Buffer.from(normalizeEol(buf.toString('utf8')), 'utf8') : buf;
  return createHash('sha256').update(data).digest('hex');
};

const lock = JSON.parse(readFileSync(join(ROOT, 'sdb.lock.json'), 'utf8'));
const SELF = lock.self;
let fail = 0;
const err = m => { console.error(`::error::${m}`); fail++; };

// ---- LOCAL PHASE — no network, runs offline and in a contributor's terminal.
for (const [localPath, meta] of Object.entries(lock.vendored)) {
  const abs = join(ROOT, localPath);
  if (!existsSync(abs)) { err(`${localPath} is vendored from DraconDex-SDB but is missing. Run: npm run sdb:vendor`); continue; }
  const got = hash(abs, localPath);
  if (got !== meta.sha256) {
    err(`${localPath} does not match the pinned DraconDex-SDB ${lock.source.version}.\n`
      + `  This file is GENERATED. Edit it in ZYDRAXYL/DraconDex-SDB (${meta.artifact}), not here.\n`
      + `  To discard the local change: npm run sdb:vendor\n`
      + `  expected ${meta.sha256}\n  got      ${got}`);
  }
}
console.log(`sdb-check local: ${Object.keys(lock.vendored).length} vendored artifact(s) checked`);

if (LOCAL_ONLY) process.exit(fail ? 1 : 0);

// ---- REMOTE PHASE — one fetch of SDB's manifest at the pinned tag.
const url = `https://raw.githubusercontent.com/${lock.source.repo}/${lock.source.ref}/generated/manifest.json`;
let manifest;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  manifest = await res.json();
} catch (e) {
  // A network failure is not a drift. Degrade to the local guarantee and say so
  // loudly, rather than either passing silently or reddening a build over a
  // transient fetch.
  console.log(`::warning::could not read ${lock.source.repo}@${lock.source.ref} manifest (${e.message}). `
    + `Local hashes were verified; the pin itself was not. ${url}`);
  process.exit(fail ? 1 : 0);
}

if (manifest.sdb.version !== lock.source.version) {
  err(`${lock.source.repo}@${lock.source.ref} publishes sdbVersion ${manifest.sdb.version}, but sdb.lock.json pins ${lock.source.version}. The tag moved under this repo.`);
}
for (const [k, want] of Object.entries(lock.expect || {})) {
  if (manifest.sources[k] !== want) err(`${k}: SDB says ${manifest.sources[k]}, this repo expects ${want}`);
}
for (const [localPath, meta] of Object.entries(lock.vendored)) {
  const remote = manifest.artifacts[meta.artifact];
  if (!remote) { err(`${meta.artifact} is vendored here but no longer published by SDB ${lock.source.version}`); continue; }
  if (remote.sha256 !== meta.sha256) err(`${meta.artifact} at ${lock.source.ref} no longer matches the copy vendored at ${localPath}`);
}
// The check a hash comparison alone cannot make: SDB added an artifact for this
// repo and nobody vendored it.
for (const [artifact, meta] of Object.entries(manifest.artifacts)) {
  const dest = meta.consumers?.[SELF];
  if (dest && !lock.vendored[dest]) {
    err(`SDB publishes ${artifact} for ${SELF} (-> ${dest}) but it is not vendored here. Run: npm run sdb:vendor`);
  }
}

if (fail) { console.error(`\nsdb-check: ${fail} problem(s).`); process.exit(1); }
console.log(`sdb-check remote: in sync with ${lock.source.repo}@${lock.source.ref} (sdbVersion ${manifest.sdb.version}, vaultSchemaVersion ${manifest.sources.vaultSchemaVersion})`);
