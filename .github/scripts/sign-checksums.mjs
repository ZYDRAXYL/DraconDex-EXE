#!/usr/bin/env node
// Procress 29 part 9 — sign a release's checksums-sha256.txt with Ed25519, so
// the app installs an update only when the file that lists its SHA-256 was
// signed by this project's key (electron/src/db/update.js checksumsSigned).
//
//   node .github/scripts/sign-checksums.mjs --keygen
//       prints a new key pair: the PRIVATE key goes into the repository secret
//       UPDATE_SIGNING_KEY (Settings → Secrets → Actions), the PUBLIC key into
//       UPDATE_PUBLIC_KEY in electron/src/db/update.js. Run once; keep the
//       private key nowhere else.
//   UPDATE_SIGNING_KEY=… node .github/scripts/sign-checksums.mjs dist-release/checksums-sha256.txt
//       writes <file>.sig (base64) beside it. With no key set it says so and
//       exits 0 — the release still ships, and the app keeps asking before it
//       installs (it never installs an unsigned update quietly).
import { readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

if (process.argv.includes('--keygen')) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  console.log('UPDATE_SIGNING_KEY (secret — private):');
  console.log(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  console.log('\nUPDATE_PUBLIC_KEY (electron/src/db/update.js — public):');
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  process.exit(0);
}

const file = process.argv[2];
if (!file) { console.error('usage: sign-checksums.mjs <checksums file> | --keygen'); process.exit(2); }
const keyB64 = String(process.env.UPDATE_SIGNING_KEY || '').trim();
if (!keyB64) {
  console.log('::notice::UPDATE_SIGNING_KEY is not set — the checksums are not signed; the app will ask before installing this update.');
  process.exit(0);
}
const key = crypto.createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' });
const text = readFileSync(file);
const sig = crypto.sign(null, text, key).toString('base64');
writeFileSync(`${file}.sig`, `${sig}\n`);
// prove it before it ships
if (!crypto.verify(null, text, crypto.createPublicKey(key), Buffer.from(sig, 'base64'))) { console.error('signature does not verify'); process.exit(1); }
console.log(`signed ${file}`);
