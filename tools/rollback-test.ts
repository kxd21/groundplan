/**
 * Going back a version — the note, and the plan it produces.
 *
 *   npx tsx tools/rollback-test.ts
 *
 * The rule this exists to hold: nothing that looks for an UPDATE can ever be
 * talked into installing something older, and the way back is only offered when
 * it leads where the user actually came from.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canRevert,
  clearRollback,
  loadRollback,
  parseRollback,
  planRevert,
  releaseManifestUrl,
  saveRollback,
} from '../src/update/rollback.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  pass  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-rollback-'));
  try {
    console.log('\nthe note\n');
    check('nothing recorded means nothing to offer', (await loadRollback(dir)) === null);

    await saveRollback(dir, { from: '1.2.1', to: '1.3.0', at: '2026-08-26T15:00:00.000Z' });
    const record = await loadRollback(dir);
    check('a hop is recorded', record?.from === '1.2.1' && record?.to === '1.3.0', JSON.stringify(record));

    check('and offered while that is the version running', canRevert(record, '1.3.0'));
    check(
      'but withdrawn once another update lands on top',
      !canRevert(record, '1.4.0'),
      'a note describing 1.2.1→1.3.0 must not offer to "go back" from 1.4.0',
    );
    check('and withdrawn after a manual reinstall of something else', !canRevert(record, '1.2.0'));
    check('no note, no offer', !canRevert(null, '1.3.0'));

    await clearRollback(dir);
    check('and it can be cleared', (await loadRollback(dir)) === null);

    console.log('\na note that cannot be trusted\n');
    // Backwards: "going back" to something newer is an upgrade wearing a
    // rollback's clothes, and the whole point of this file is that it cannot be
    // used to move somebody forward.
    check('a backwards note is refused', parseRollback({ from: '1.3.0', to: '1.2.1' }) === null);
    check('an equal note is refused', parseRollback({ from: '1.3.0', to: '1.3.0' }) === null);
    check('junk is refused', parseRollback({ from: 'latest', to: '1.3.0' }) === null);
    check('nothing is refused', parseRollback(null) === null);
    // Anything that could escape the URL it gets pasted into.
    check(
      'a version that is really a path is refused',
      parseRollback({ from: '../../evil', to: '1.3.0' }) === null,
    );
    writeFileSync(join(dir, 'rollback.json'), '{ not json');
    check('an unreadable note reads as no note', (await loadRollback(dir)) === null);

    console.log('\nthe URL a revert reaches for\n');
    check(
      'it is the release own manifest, by version',
      releaseManifestUrl('1.2.1').endsWith('/app-v1.2.1/app-manifest.json'),
      releaseManifestUrl('1.2.1'),
    );

    console.log('\nplanning the revert\n');
    const base = { currentVersion: '1.3.0', platform: 'darwin', arch: 'arm64' };

    const bad = await planRevert('not-a-version', { ...base, url: 'about:blank' });
    check('a version that is not one is refused before any fetch', !bad.available, bad.reason);

    // Unreachable release: an ordinary answer, not a crash.
    const missing = await planRevert('9.9.9', {
      ...base,
      url: 'https://127.0.0.1:1/app-manifest.json',
    });
    check('an unreachable release is reported, not thrown', !missing.available, missing.reason);

    console.log(`\n${passed}/${passed + failed} checks passed`);
    if (failed) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
