// Pull this repo's vendored artifacts from DraconDex-SDB and rewrite the pin.
//
//   node tools/sdb-vendor.mjs                 re-fetch at the pinned version
//   node tools/sdb-vendor.mjs --ref sdb-v1.1.0  move the pin, then fetch
//   node tools/sdb-vendor.mjs --init          build a lock from scratch
//
// SDB's manifest declares WHERE each artifact must land in each consumer, so
// this tool never hardcodes a destination — it reads `consumers[self]`. That is
// what lets SDB add an artifact without every consumer needing a code change.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  let d = dirname(dirname(fileURLToPath(import.meta.url)));
  return existsSync(join(d, 'chain', 'chain.json')) ? d : dirname(fileURLToPath(import.meta.url)).replace(/\/tools$/, '');
})();
const argOf = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const INIT = process.argv.includes('--init');

const SELF = JSON.parse(readFileSync(join(ROOT, 'chain', 'chain.json'), 'utf8')).self;
const lockPath = join(ROOT, 'sdb.lock.json');
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8'))
  : { lockVersion: 1, self: SELF, source: { repo: 'ZYDRAXYL/DraconDex-SDB', ref: 'main', version: null }, expect: {}, vendored: {} };
const ref = argOf('--ref') || lock.source.ref;
const raw = p => `https://raw.githubusercontent.com/${lock.source.repo}/${ref}/${p}`;

const normalizeEol = s => s.replace(/\r\n/g, '\n');
const isText = p => /\.(js|dart|sql|json|md|mjs|txt)$/.test(p);
const digest = (buf, rel) =>
  createHash('sha256').update(isText(rel) ? Buffer.from(normalizeEol(buf.toString('utf8')), 'utf8') : buf).digest('hex');

async function get(path, binary = false) {
  const res = await fetch(raw(path), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} fetching ${path} from ${lock.source.repo}@${ref}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

const manifest = JSON.parse(await get('generated/manifest.json'));
const mine = Object.entries(manifest.artifacts).filter(([, m]) => m.consumers?.[SELF]);
if (!mine.length) {
  console.error(`::error::DraconDex-SDB@${ref} publishes nothing for ${SELF}. Check chain/chain.json's "self".`);
  process.exit(1);
}

const vendored = {};
let changed = 0;
for (const [artifact, meta] of mine) {
  const dest = meta.consumers[SELF];
  const abs = join(ROOT, dest);
  const buf = await get(artifact, !isText(artifact));
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  const got = digest(body, artifact);
  if (got !== meta.sha256) {
    // Refuse rather than write: a hash mismatch here means the manifest and the
    // file it describes disagree at the source, and vendoring it would import
    // that inconsistency.
    console.error(`::error::${artifact} does not match its own manifest hash at ${ref} — refusing to vendor it.`);
    process.exit(1);
  }
  const cur = existsSync(abs) ? readFileSync(abs) : null;
  if (!cur || Buffer.compare(cur, body) !== 0) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    changed++;
    console.log(`  ${existsSync(abs) && cur ? 'updated' : 'added  '} ${dest}`);
  }
  vendored[dest] = { artifact, sha256: meta.sha256 };
}

lock.lockVersion = 1;
lock.self = SELF;
lock.source = { repo: lock.source.repo, ref, version: manifest.sdb.version };
lock.expect = {
  vaultSchemaVersion: manifest.sources.vaultSchemaVersion,
  supabaseSchemaVersion: manifest.sources.supabaseSchemaVersion,
};
lock.vendored = vendored;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log(`${INIT ? 'initialised' : 'vendored'} ${mine.length} artifact(s) from ${lock.source.repo}@${ref} (sdbVersion ${manifest.sdb.version}); ${changed} file(s) changed`);
