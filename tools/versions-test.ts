/**
 * Named versions, and what changed between two of them.
 *
 *   npx tsx tools/versions-test.ts
 *
 * The comparison has one job: describe a revision the way a person would.
 * "24 removed, 24 added" is what a byte diff says about a bank of chairs that
 * moved six feet, and it is useless. "24 moved" is the answer.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deleteVersion,
  listVersions,
  pruneOrphans,
  readVersion,
  renameVersion,
  saveVersion,
  versionDirFor,
} from '../src/main/version-store.js';
import { diffPlans, summariseDiff } from '../src/format/versions.js';
import type { PlacedItem } from '../src/format/definition.js';

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

const FT = 120;

function item(name: string, x: number, y: number, extra: Partial<PlacedItem> = {}): PlacedItem {
  return {
    nodeId: 0,
    key: `${name}@${x},${y}`,
    name,
    x,
    y,
    rotation: 0,
    width: 2 * FT,
    depth: 2 * FT,
    elevation: 0,
    top: 0,
    obstruction: 'none',
    seats: 0,
    spec: { id: name, name },
    ...extra,
  } as unknown as PlacedItem;
}

console.log('\na revision reads the way somebody describes it');
{
  const before = [
    item('Round 66"', 10 * FT, 10 * FT),
    item('Round 66"', 20 * FT, 10 * FT),
    item('Podium', 30 * FT, 5 * FT),
    item('Fastfold Screen', 40 * FT, 4 * FT),
  ];
  const after = [
    // One round unchanged, one moved across the room.
    item('Round 66"', 10 * FT, 10 * FT),
    item('Round 66"', 20 * FT, 26 * FT),
    // The podium turned in place.
    item('Podium', 30 * FT, 5 * FT, { rotation: 90 }),
    // The screen is gone; a wall arrived.
    item('LED wall', 40 * FT, 4 * FT),
  ];

  const diff = diffPlans(before, after);

  check('the move is reported as a move, not a delete plus an add',
    diff.moved.length === 1 && diff.added.length === 1 && diff.removed.length === 1,
    JSON.stringify({ moved: diff.moved.length, added: diff.added.length, removed: diff.removed.length }));
  check('the moved item is named', diff.moved[0]?.name === 'Round 66"', diff.moved[0]?.name);
  check(
    'and carries where it came from and how far',
    diff.moved[0]?.fromY === 10 * FT && Math.abs((diff.moved[0]?.distance ?? 0) - 16 * FT) < 1e-6,
    JSON.stringify(diff.moved[0]),
  );
  check('the removal is the screen', diff.removed[0]?.name === 'Fastfold Screen', diff.removed[0]?.name);
  check('the addition is the wall', diff.added[0]?.name === 'LED wall', diff.added[0]?.name);
  check(
    'the turn is reported as a change, in degrees',
    diff.changed.some((c) => c.name === 'Podium' && /turned 90/.test(c.detail ?? '')),
    JSON.stringify(diff.changed),
  );
  check('and the summary says all four', /added/.test(diff.summary) && /moved/.test(diff.summary), diff.summary);
  check('a diff with changes is not identical', !diff.identical);
}

console.log('\nnoise is not a change');
{
  const before = [item('Round 66"', 10 * FT, 10 * FT)];
  // Moved by two inches: a snap step, not a decision.
  const after = [item('Round 66"', 10 * FT + 20, 10 * FT)];
  const diff = diffPlans(before, after);
  check('a two-inch shift is not a move', diff.moved.length === 0, JSON.stringify(diff.moved));
  check('and nothing else is reported either', diff.identical, diff.summary);

  const same = diffPlans(before, before);
  check('a plan compared with itself is identical', same.identical && same.summary === 'No differences');
  check('two empty plans are identical', diffPlans([], []).identical);
}

console.log('\na whole bank moving reads as one line per item name');
{
  const before = Array.from({ length: 24 }, (_, i) => item('Chair', (10 + i) * FT, 10 * FT));
  const after = Array.from({ length: 24 }, (_, i) => item('Chair', (10 + i) * FT, 16 * FT));
  const diff = diffPlans(before, after);
  check('all 24 are moves', diff.moved.length === 24, `${diff.moved.length} moved, ${diff.added.length} added`);
  check('none is reported as added or removed', diff.added.length === 0 && diff.removed.length === 0);

  const rolled = summariseDiff(diff);
  check('the summary rolls them into one row', rolled.length === 1, JSON.stringify(rolled));
  check('naming the item and the count', rolled[0]?.name === 'Chair' && rolled[0]?.moved === 24, JSON.stringify(rolled[0]));
}

console.log('\nversions are kept beside the plan');
{
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-versions-'));
  const plan = join(dir, 'Show.rv4');
  writeFileSync(plan, Buffer.from('version one'));

  const first = saveVersion(plan, Buffer.from('version one'), 'Initial layout');
  check('a version saves', first.ok, first.ok ? '' : first.reason);

  check('the store sits beside the plan', versionDirFor(plan).startsWith(dir));
  check('and exists on disk', existsSync(versionDirFor(plan)));

  const blank = saveVersion(plan, Buffer.from('x'), '   ');
  check('an unnamed version is refused', !blank.ok && /name/i.test(blank.ok ? '' : blank.reason));

  const duplicate = saveVersion(plan, Buffer.from('version one'), 'Same again');
  check(
    'an identical snapshot is refused rather than duplicated',
    !duplicate.ok && /identical/i.test(duplicate.ok ? '' : duplicate.reason),
    duplicate.ok ? 'it saved' : duplicate.reason,
  );

  const second = saveVersion(plan, Buffer.from('version two'), 'Client revision');
  check('a changed snapshot saves', second.ok);

  const list = listVersions(plan);
  check('both versions are listed', list.length === 2, `${list.length}`);
  check('newest first', list[0]?.name === 'Client revision', list.map((v) => v.name).join(', '));
  check('with a size and a timestamp', list[0]!.size > 0 && !!Date.parse(list[0]!.savedAt));

  const bytes = readVersion(plan, list[1]!.id);
  check('a snapshot reads back byte for byte', bytes?.toString() === 'version one', bytes?.toString());
  check('an unknown id reads back nothing', readVersion(plan, 'nope') === null);



  check('a version renames', renameVersion(plan, list[0]!.id, 'Final production'));
  check('and the new name sticks', listVersions(plan)[0]?.name === 'Final production');
  check('renaming to blank is refused', !renameVersion(plan, list[0]!.id, '  '));

  // An orphan snapshot must be collectable, and a live one must not be.
  writeFileSync(join(versionDirFor(plan), 'orphan.snapshot'), Buffer.from('junk'));
  check('an orphan snapshot is pruned', pruneOrphans(plan) === 1);
  check(
    'and the real ones survive',
    readdirSync(versionDirFor(plan)).filter((f) => f.endsWith('.snapshot')).length === 2,
  );

  check('a version deletes', deleteVersion(plan, list[0]!.id));
  check('and is gone from the list', listVersions(plan).length === 1);
  check('deleting an unknown id reports false', !deleteVersion(plan, 'nope'));

  // A plan that has never been versioned must answer cleanly, not throw.
  const fresh = join(dir, 'Never.rv4');
  check('a plan with no versions lists none', listVersions(fresh).length === 0);
  check('and prunes nothing', pruneOrphans(fresh) === 0);

  rmSync(dir, { recursive: true, force: true });
}

{
  /*
   * Versions saved inside the same millisecond still order correctly.
   *
   * `savedAt` is an ISO timestamp with millisecond resolution, so two saves in
   * quick succession can carry the SAME string — which is not exotic, it is
   * what happens whenever anything saves twice in a row. A tie left the order
   * to sort stability, so "newest" was undefined: the list could come back the
   * wrong way round, and `saveVersion` refuses duplicates by comparing against
   * "the newest", so a tie could compare against the wrong snapshot. This test
   * used to fail about one run in three, which is worse than failing every
   * time — a flaky gate is one nobody trusts.
   *
   * Six saves with no delay between them: at least two will share a millisecond
   * on any machine this runs on.
   */
  const burstDir = mkdtempSync(join(tmpdir(), 'groundplan-versions-burst-'));
  const burstPlan = join(burstDir, 'Burst.rv4');
  writeFileSync(burstPlan, Buffer.from('start'));
  for (let i = 0; i < 6; i++) saveVersion(burstPlan, Buffer.from(`burst ${i}`), `Burst ${i}`);
  const burst = listVersions(burstPlan);
  check('a burst of saves all land', burst.length === 6, `${burst.length}`);
  check('the newest of the burst is first', burst[0]?.name === 'Burst 5', burst.map((v) => v.name).join(', '));
  check(
    'and the whole burst reads back in the order it was saved',
    burst.slice(0, 6).every((v, i) => v.name === `Burst ${5 - i}`),
    burst.slice(0, 6).map((v) => v.name).join(', '),
  );
  check(
    'each one still holds its own bytes',
    burst.slice(0, 6).every((v, i) => readVersion(burstPlan, v.id)?.toString() === `burst ${5 - i}`),
  );
  rmSync(burstDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
