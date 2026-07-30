/**
 * Generates the catalog signing key pair.
 *
 * Run once. The private key signs every release; the public key is compiled
 * into the application so an install can tell a genuine release from anything
 * else. Losing the private key means publishing under a new key and shipping an
 * app update that pins it, so it is worth keeping somewhere durable.
 *
 *   npx tsx tools/catalog-keygen.ts
 *
 * The private key is written to a git-ignored file and printed nowhere. Add it
 * to CI as a secret with:
 *
 *   gh secret set CATALOG_SIGNING_KEY < catalog-signing-key.pem
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const PRIVATE_PATH = 'catalog-signing-key.pem';
const PUBLIC_PATH = 'catalog-signing-key.pub';

if (existsSync(PRIVATE_PATH)) {
  console.error(
    `${PRIVATE_PATH} already exists. Refusing to overwrite it — a replaced key ` +
      `invalidates every release signed with the old one.`,
  );
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// 0o600: the key is the only thing standing between the catalog and anyone who
// wants to publish to every installed copy of the application.
writeFileSync(PRIVATE_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });

const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
writeFileSync(PUBLIC_PATH, `${spki}\n`, 'utf8');

console.log('Generated an Ed25519 signing key pair.\n');
console.log(`  private  ${PRIVATE_PATH}   (git-ignored — never commit this)`);
console.log(`  public   ${PUBLIC_PATH}\n`);
console.log('Public key, to pin in the application:\n');
console.log(`  ${spki}\n`);
console.log('Add the private key to CI:\n');
console.log(`  gh secret set CATALOG_SIGNING_KEY < ${PRIVATE_PATH}`);
