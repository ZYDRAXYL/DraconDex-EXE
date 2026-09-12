'use strict';
// DDX Transfer — the wire format, and nothing else.
//
// Deliberately free of any `electron` (or database) dependency so it can be
// loaded and held to the contract by electron/test/transfer-crypto.test.mjs
// under plain `node --test`. src/db/transfer.js does the config, transport and
// session work on top of it.
//
// This is the Node third of a THREE-WAY CONTRACT:
//
//   Browser   public/assets/js/ddx-crypto.js                  in DraconDex-TRX
//   Node      this file                                       in DraconDex-EXE
//   Dart      lib/data/services/ddx_transfer_service.dart     in DraconDex-APK
//
// A mismatch between any two of them does not throw. It delivers a vault that
// imports as nonsense, on someone else's machine, hours later. So every
// parameter is written out here rather than left to a library default that
// might differ across three runtimes:
//
//   key        32 random bytes, made by the sender, NEVER uploaded
//   payload    gzip(snapshot JSON) -> split -> AES-256-GCM per chunk
//   chunk      [12-byte IV][ciphertext || 16-byte GCM tag]
//   manifest   AES-256-GCM over JSON, carried as { iv, ct } (base64)
//   pinWrap    AES-256-GCM over the key, under
//              PBKDF2-SHA256(code + ":" + pin, salt, 600000) -> 32 bytes
const crypto = require('crypto');

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PBKDF2_ITERS = 600000;

const newKey = () => crypto.randomBytes(KEY_BYTES);

function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { iv, ct };
}

function open(key, iv, ct) {
  // WebCrypto and Dart both APPEND the GCM tag to the ciphertext; node:crypto
  // wants it handed over separately. Splitting it back off here is precisely
  // what makes the three implementations interoperable.
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG_BYTES)), d.final()]);
}

/** Frames one chunk as [IV][ciphertext] so a chunk carries its own nonce. */
function sealChunk(key, plaintext) {
  const { iv, ct } = seal(key, plaintext);
  return Buffer.concat([iv, ct]);
}

function openChunk(key, framed) {
  const buf = Buffer.from(framed);
  // `<`, not `<=`: an empty payload seals to exactly IV + tag and is a
  // perfectly valid authenticated chunk. Rejecting it would make an empty
  // vault the one thing that cannot be sent.
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('chunk_too_short');
  return open(key, buf.subarray(0, IV_BYTES), buf.subarray(IV_BYTES));
}

function sealJson(key, obj) {
  const { iv, ct } = seal(key, Buffer.from(JSON.stringify(obj), 'utf8'));
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

const openJson = (key, sealed) => JSON.parse(
  open(key, Buffer.from(sealed.iv, 'base64'), Buffer.from(sealed.ct, 'base64')).toString('utf8'),
);

const deriveWrapKey = (code, pin, salt, iters) =>
  crypto.pbkdf2Sync(`${code}:${pin}`, salt, iters, KEY_BYTES, 'sha256');

/** Seals the transfer key under the PIN — the typed-code path only. */
function wrapKeyWithPin(key, code, pin) {
  const salt = crypto.randomBytes(16);
  const { iv, ct } = seal(deriveWrapKey(code, pin, salt, PBKDF2_ITERS), key);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    salt: salt.toString('base64'),
    iters: PBKDF2_ITERS,
  };
}

const unwrapKeyWithPin = (pinWrap, code, pin) => open(
  deriveWrapKey(code, pin, Buffer.from(pinWrap.salt, 'base64'), pinWrap.iters),
  Buffer.from(pinWrap.iv, 'base64'),
  Buffer.from(pinWrap.ct, 'base64'),
);

function splitChunks(buf, maxPlainBytes) {
  const out = [];
  for (let at = 0; at < buf.length; at += maxPlainBytes) {
    out.push(buf.subarray(at, Math.min(at + maxPlainBytes, buf.length)));
  }
  // The service rejects chunkCount < 1, so "nothing to send" has to mean one
  // chunk carrying nothing, not no chunks at all.
  return out.length ? out : [Buffer.alloc(0)];
}

/** The code as typed, normalized to the form the wrap key is derived from. */
const canonicalCode = (raw) => String(raw).toUpperCase().replace(/[^0-9A-Z]/g, '')
  .replace(/[IL]/g, '1').replace(/O/g, '0');

const canonicalPin = (raw) => String(raw).replace(/[^0-9]/g, '');

module.exports = {
  KEY_BYTES, IV_BYTES, TAG_BYTES, PBKDF2_ITERS,
  newKey, sealChunk, openChunk, sealJson, openJson,
  wrapKeyWithPin, unwrapKeyWithPin, splitChunks, canonicalCode, canonicalPin,
};
