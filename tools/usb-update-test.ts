/**
 * Updating from a USB stick.
 *
 * Most of these are refusals, because that is where the value is. A stick is
 * handed over in a loading dock by someone you half know; the whole design rests
 * on it being no more dangerous than a web server, and that only holds if the
 * unsigned, tampered and truncated cases are actually rejected.
 *
 *   npx tsx tools/usb-update-test.ts
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { canonicalise, sha256 } from '../src/catalog/manifest.js';
import { CATALOG_PUBLIC_KEYS } from '../src/catalog/keys.js';
import type { AppManifest } from '../src/update/app-update.js';
import {
  findReleaseFolder,
  planUsbUpdate,
  readUsbSource,
  stageUsbUpdate,
} from '../src/update/usb-update.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
  return ok;
}

const dir = mkdtempSync(join(tmpdir(), 'groundplan-usb-'));
const staging = join(dir, 'staging');

/** The real signing key, when it is on this machine. */
const REAL_KEY = 'catalog-signing-key.pem';
const canSignForReal = existsSync(REAL_KEY);

/** A key that is *not* pinned — stands in for somebody else's release. */
const foreign = generateKeyPairSync('ed25519');

interface Release {
  folder: string;
  archive: string;
}

function writeRelease(
  name: string,
  version: string,
  options: { key?: 'real' | 'foreign' | 'none'; bytes?: Buffer; corruptAfter?: boolean } = {},
): Release {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });

  const archive = `Groundplan-${version}-mac-arm64.zip`;
  const payload = options.bytes ?? Buffer.from(`pretend archive for ${version}`);
  writeFileSync(join(folder, archive), payload);

  const manifest: AppManifest = {
    schema: 1,
    version,
    released: new Date(0).toISOString(),
    packages: {
      'darwin-arm64': { url: archive, bytes: payload.length, sha256: sha256(payload) },
    },
  };

  const which = options.key ?? (canSignForReal ? 'real' : 'foreign');
  let signature: string | undefined;
  if (which === 'real') {
    signature = cryptoSign(null, Buffer.from(canonicalise(manifest), 'utf8'), readFileSync(REAL_KEY, 'utf8')).toString('base64');
  } else if (which === 'foreign') {
    signature = cryptoSign(null, Buffer.from(canonicalise(manifest), 'utf8'), foreign.privateKey).toString('base64');
  }

  writeFileSync(
    join(folder, 'app-manifest.json'),
    JSON.stringify(signature ? { ...manifest, signature } : manifest, null, 2),
  );

  // Swap the archive *after* signing: the manifest still describes the old
  // bytes, which is exactly what tampering looks like.
  if (options.corruptAfter) writeFileSync(join(folder, archive), Buffer.from('something else entirely'));

  return { folder, archive: join(folder, archive) };
}

async function main(): Promise<void> {
  try {
    console.log('a stick that is not signed by us\n');

    {
      const release = writeRelease('foreign', '9.9.9', { key: 'foreign' });
      const { source, reason } = await readUsbSource(release.folder);
      check('a release signed with someone else\'s key is refused', !source);
      check('and the refusal says why, in plain words', !!reason && reason.includes('not signed by Groundplan'), reason);
    }

    {
      const release = writeRelease('unsigned', '9.9.9', { key: 'none' });
      const { source } = await readUsbSource(release.folder);
      check('an unsigned release is refused', !source);
    }

    {
      const folder = join(dir, 'empty');
      mkdirSync(folder, { recursive: true });
      const { source, reason } = await readUsbSource(folder);
      check('a folder with no manifest is refused', !source);
      check('and says which file it wanted', !!reason && reason.includes('app-manifest.json'), reason);
    }

    {
      const folder = join(dir, 'damaged');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'app-manifest.json'), '{ not json');
      const { source, reason } = await readUsbSource(folder);
      check('a damaged manifest is refused', !source);
      check('and is called damaged, not unsigned', !!reason && reason.includes('damaged'), reason);
    }

    if (!canSignForReal) {
      console.log('\n  (no signing key on this machine — the accept-path checks need one)\n');
      console.log(`\n${passed}/${passed + failed} checks passed`);
      if (failed) process.exit(1);
      return;
    }

    console.log('\na stick that is properly signed\n');

    {
      const release = writeRelease('good', '99.0.0');
      const { source } = await readUsbSource(release.folder);
      check('a correctly signed release is accepted', !!source);
      if (!source) return;

      const plan = planUsbUpdate(source, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
      check('a newer version is offered', plan.available && plan.latestVersion === '99.0.0', plan.reason);

      const staged = await stageUsbUpdate(source, plan, staging);
      check('it stages off the drive', staged.ok, staged.reason);
      check('leaving the archive where the installer wants it', !!staged.archivePath && existsSync(staged.archivePath));
      check('copied, not referenced on the drive', !!staged.archivePath && !staged.archivePath.startsWith(source.folder));
    }

    {
      // The version comparisons, which are what stop a stick downgrading someone.
      const release = writeRelease('same', '1.1.0');
      const { source } = await readUsbSource(release.folder);
      const same = planUsbUpdate(source!, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
      check('the same version is not offered', !same.available);
      check('and says so rather than failing', !!same.reason && same.reason.includes('what you are running'), same.reason);

      const newer = planUsbUpdate(source!, { currentVersion: '2.0.0', platform: 'darwin', arch: 'arm64' });
      check('an older version on the drive is refused', !newer.available);
      check('and is described as older', !!newer.reason && newer.reason.includes('older'), newer.reason);

      const other = planUsbUpdate(source!, { currentVersion: '1.0.0', platform: 'win32', arch: 'x64' });
      check('a build for another computer is not offered', !other.available);
      check('and names the platform it lacked', !!other.reason && other.reason.includes('win32-x64'), other.reason);
    }

    {
      // Tampering: the manifest is genuinely signed, but the archive beside it
      // was swapped afterwards. The signature passes and the hash must not.
      const release = writeRelease('tampered', '99.0.0', { corruptAfter: true });
      const { source } = await readUsbSource(release.folder);
      check('a tampered stick still passes the signature check', !!source);

      const plan = planUsbUpdate(source!, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
      const staged = await stageUsbUpdate(source!, plan, staging);
      check('but the swapped archive is caught', !staged.ok);
      check(
        'by size or by hash, and refused either way',
        !!staged.reason && (staged.reason.includes('signature') || staged.reason.includes('wrong size')),
        staged.reason,
      );
    }

    {
      // Same length, different bytes — gets past the size check and has to be
      // caught by the hash.
      const original = Buffer.from('pretend archive for 99.0.0');
      const release = writeRelease('swapped', '99.0.0', { bytes: original });
      writeFileSync(release.archive, Buffer.alloc(original.length, 0x41));
      const { source } = await readUsbSource(release.folder);
      const plan = planUsbUpdate(source!, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
      const staged = await stageUsbUpdate(source!, plan, staging);
      check('an archive of the right length but wrong content is refused', !staged.ok);
      check('specifically for not matching its signature', !!staged.reason && staged.reason.includes('signature'), staged.reason);
      check(
        'and the bad copy is not left in staging',
        !existsSync(join(staging, `Groundplan-99.0.0-mac-arm64.zip`)),
      );
    }

    {
      const release = writeRelease('missing', '99.0.0');
      rmSync(release.archive);
      const { source } = await readUsbSource(release.folder);
      const plan = planUsbUpdate(source!, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' });
      const staged = await stageUsbUpdate(source!, plan, staging);
      check('a manifest naming an absent archive is refused', !staged.ok);
      check('and names the missing file', !!staged.reason && staged.reason.includes('.zip'), staged.reason);
    }

    console.log('\nfinding the folder on a drive\n');

    {
      const drive = join(dir, 'drive');
      mkdirSync(join(drive, 'GROUNDPLAN'), { recursive: true });
      const release = writeRelease(join('drive', 'GROUNDPLAN'), '99.0.0');
      void release;

      check('a release one level down is found', (await findReleaseFolder(drive))?.endsWith('GROUNDPLAN') === true);
      check(
        'and so is one at the root',
        (await findReleaseFolder(join(drive, 'GROUNDPLAN'))) === join(drive, 'GROUNDPLAN'),
      );
      check('a drive with nothing on it returns nothing', (await findReleaseFolder(join(dir, 'empty'))) === null);
      check('an unreadable path returns nothing rather than throwing', (await findReleaseFolder(join(dir, 'nope'))) === null);
    }

    check('the pinned key set is not empty', CATALOG_PUBLIC_KEYS.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

void main();
