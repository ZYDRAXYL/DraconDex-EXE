import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const C = require('../src/db/transfer-crypto.js');

// These tests match source text with regexes anchored on `\n`. `.gitattributes`
// says `* text=auto`, so a Windows checkout (the CI runner) has CRLF endings
// and those anchors stop matching — read every source through here instead.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/**
 * DDX Transfer's wire format is implemented THREE times — here in Node, in
 * DraconDex-TRX's public/assets/js/ddx-crypto.js (the source of truth), and in
 * DraconDex-APK's lib/data/services/ddx_transfer_service.dart.
 *
 * A disagreement between any two of them does not throw. It hands someone a
 * vault that imports as nonsense, on another machine, hours later. These tests
 * pin the parameters and the framing so a drift shows up here instead.
 */

test('the wire parameters are the ones all three implementations agree on', () => {
  assert.equal(C.KEY_BYTES, 32);
  assert.equal(C.IV_BYTES, 12);
  assert.equal(C.TAG_BYTES, 16);
  assert.equal(C.PBKDF2_ITERS, 600000);
});

test('a chunk is framed as [12-byte IV][ciphertext || 16-byte tag]', () => {
  const key = C.newKey();
  const plain = Buffer.from('a vault');
  const framed = C.sealChunk(key, plain);

  // The exact framing is the contract: Dart and WebCrypto both append the GCM
  // tag to the ciphertext, and node:crypto is the one that wants it handed
  // over separately. Getting that split wrong is silent in one direction.
  assert.equal(framed.length, C.IV_BYTES + plain.length + C.TAG_BYTES);
  assert.deepEqual(C.openChunk(key, framed), plain);
});

test('a snapshot survives gzip, chunking, sealing and the whole way back', () => {
  const snapshot = Buffer.from(JSON.stringify({
    format: 'dracondex-vault-snapshot', version: 1,
    nexus: { name: 'My World' },
    modules: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Module ${i}`, kind: 'classifier' })),
  }));
  const key = C.newKey();
  const gz = gzipSync(snapshot);

  const slices = C.splitChunks(gz, 512 - C.IV_BYTES - C.TAG_BYTES);
  assert.ok(slices.length > 1, 'the fixture must actually span several chunks');

  const framed = slices.map((s) => C.sealChunk(key, s));
  // The reason splitChunks subtracts the framing: a chunk one byte over the
  // service's cap is rejected, and it would only ever be the LAST chunk of a
  // large vault — the case nobody hits by hand.
  for (const f of framed) assert.ok(f.length <= 512, `framed chunk ${f.length} exceeds the cap`);

  const back = Buffer.concat(framed.map((f) => C.openChunk(key, f)));
  assert.deepEqual(gunzipSync(back), snapshot);
});

test('an empty payload still produces one openable chunk', () => {
  // The service rejects chunkCount < 1, and an empty payload seals to exactly
  // IV + tag. A `<=` length guard here made an empty vault the one thing that
  // could not be sent.
  const slices = C.splitChunks(Buffer.alloc(0), 1024);
  assert.equal(slices.length, 1);
  const key = C.newKey();
  assert.equal(C.openChunk(key, C.sealChunk(key, slices[0])).length, 0);
});

test('the manifest round-trips, non-ASCII names included', () => {
  const key = C.newKey();
  const manifest = { v: 1, name: 'โลกของฉัน', sizeBytes: 2411, compression: 'gzip', createdAt: 1700000000000, source: 'exe' };
  assert.deepEqual(C.openJson(key, C.sealJson(key, manifest)), manifest);
});

test('pinWrap round-trips, and only with the right code and PIN', () => {
  const key = C.newKey();
  const wrap = C.wrapKeyWithPin(key, 'ABCD1234', '482719');

  assert.deepEqual(C.unwrapKeyWithPin(wrap, 'ABCD1234', '482719'), key);
  assert.throws(() => C.unwrapKeyWithPin(wrap, 'ABCD1234', '000000'));
  // The code is bound in too, so a pinWrap lifted from one transfer is
  // useless against another that happens to share a PIN.
  assert.throws(() => C.unwrapKeyWithPin(wrap, 'ZZZZ9999', '482719'));

  // The service's commit handler rejects anything outside this band.
  assert.ok(wrap.iters >= 100000 && wrap.iters <= 2000000);
});

test('pinWrap survives the code and PIN being typed the way a person types them', () => {
  const key = C.newKey();
  // Sealed under what the service issued...
  const wrap = C.wrapKeyWithPin(key, 'ABCD1234', '482719');
  // ...opened with what the screen showed. Every one of these has to derive
  // the same key, or the typed-code path fails 100% of the time while looking
  // exactly like a wrong PIN.
  for (const [code, pin] of [['ABCD-1234', '482-719'], ['abcd-1234', '482 719'], ['  ABCD 1234 ', '482719']]) {
    assert.deepEqual(
      C.unwrapKeyWithPin(wrap, C.canonicalCode(code), C.canonicalPin(pin)), key,
      `typed as ${JSON.stringify(code)} / ${JSON.stringify(pin)}`,
    );
  }
});

test('the Crockford substitutions the code alphabet exists for are applied', () => {
  // I, L, O and U are excluded from the alphabet precisely because they get
  // misread; forgiving the misreadings is the point of choosing it.
  assert.equal(C.canonicalCode('IL0O-1234'), '11001234');
  assert.equal(C.canonicalPin('482-719'), '482719');
});

test('a tampered chunk fails the tag rather than decrypting to garbage', () => {
  const key = C.newKey();
  const framed = C.sealChunk(key, Buffer.from('a vault'));
  const tampered = Buffer.from(framed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => C.openChunk(key, tampered));
});

test('the wrong key fails the same way', () => {
  const framed = C.sealChunk(C.newKey(), Buffer.from('a vault'));
  assert.throws(() => C.openChunk(C.newKey(), framed));
});

test('transfer-crypto.js stays free of electron and database imports', () => {
  // The whole reason this file is split out of transfer.js: requiring
  // `electron` would make the wire contract untestable under plain node,
  // which is how it would quietly stop being tested.
  const src = readSource('../src/db/transfer-crypto.js');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto'], `unexpected imports: ${requires.join(', ')}`);
});

test('transfer.js reaches gzip only through the form a browser can shim', () => {
  // DraconDex-PWA bundles this file for the browser with esbuild and aliases
  // each Node built-in to a shim/. A browser's only gzip is CompressionStream,
  // which is a stream — so `zlib.gzipSync` cannot be shimmed at any cost, and
  // using it breaks the desktop lane's build outright rather than at runtime.
  //
  // This is a regression guard, not a style rule: gzipSync is exactly what was
  // here first, and it took a failed PWA build to notice.
  const src = readSource('../src/db/transfer.js');

  assert.doesNotMatch(src, /zlib\.(gzip|gunzip|deflate|inflate|brotliCompress|brotliDecompress)Sync\b/,
    'sync zlib cannot be shimmed for the browser lane — use the callback form');

  // And the callback form has to actually be the one in use, so this test
  // cannot pass by gzip having been dropped altogether.
  assert.match(src, /zlib\.gzip\(/, 'the callback form of gzip must be used');
  assert.match(src, /zlib\.gunzip\(/, 'the callback form of gunzip must be used');
});

test('a lane without gzip still sends, and says so in the manifest', () => {
  // CompressionStream is absent on older Safari. The send path falls back to an
  // uncompressed payload rather than failing, which is only safe because every
  // receiver branches on the manifest's `compression` field — this file, the
  // browser implementation in DraconDex-TRX, and the Dart one in DraconDex-APK
  // all do. A hardcoded 'gzip' here would make that fallback silently corrupt.
  const src = readSource('../src/db/transfer.js');
  assert.doesNotMatch(src, /compression:\s*'gzip'/,
    "the manifest must report what actually happened, not assume gzip");
  assert.match(src, /compression\s*=\s*'none'/, 'the uncompressed fallback must exist');
  assert.match(src, /s\.manifest\.compression === 'gzip'/,
    'the receive path must branch on the manifest, not assume gzip');
});

test('the transfer URL is validated before a vault is sent to it', () => {
  // Same rule and same reason as sync.js's isAllowedSyncUrl: whatever is
  // stored here is where an entire vault gets uploaded, so a renderer-side
  // call must not be able to repoint it at plain http or an internal address.
  const src = readSource('../src/db/transfer.js');
  const fn = src.match(/function isAllowedTransferUrl\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn, 'isAllowedTransferUrl not found');
  assert.match(fn, /u\.protocol === 'https:'/);
  assert.match(fn, /localhost/, 'loopback must stay allowed for `netlify dev`');

  const setter = src.match(/function setTransferConfig\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(setter, /isAllowedTransferUrl/, 'setTransferConfig must run the check');
});

test('the transfer key is never handed to the renderer', () => {
  // main.js passes `link` through, which carries the key in its fragment for
  // the QR — but no IPC handler may return the key on its own, and none may
  // accept one. If that changes, the renderer becomes able to leak it.
  const src = readSource('../src/db/transfer.js');
  const exported = src.match(/module\.exports = \{[\s\S]*?\n\};/)?.[0] || '';
  assert.ok(exported, 'module.exports not found');
  assert.doesNotMatch(exported, /\bnewKey\b|\bsealChunk\b|\bwrapKeyWithPin\b/,
    'transfer.js must not re-export crypto primitives across the IPC surface');
});
