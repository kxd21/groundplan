/**
 * Two things in the same place — detection, and the way out.
 *
 *   npx tsx tools/overlap-test.ts
 */
import {
  besidePosition,
  describeOverlap,
  findOverlaps,
  intersection,
  type OverlapCandidate,
} from '../src/format/overlap.js';

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  pass  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const F = 120;
const box = (x: number, y: number, w: number, h: number) => ({
  minX: x * F, minY: y * F, maxX: (x + w) * F, maxY: (y + h) * F,
});
const at = (id: number, name: string, x: number, y: number, w: number, h: number): OverlapCandidate =>
  ({ id, name, ...box(x, y, w, h) });

console.log('\nwhen two things share space\n');
{
  const table = at(1, 'Round 72"', 0, 0, 6, 6);

  // A chair mostly on the table is a stack, whichever was drawn first.
  const chair = box(4, 4, 2, 2);
  const onIt = findOverlaps(chair, [table]);
  check('a chair inside a table is reported', onIt.length === 1, JSON.stringify(onIt));
  check('and the whole chair is buried', onIt[0]!.fraction === 1, `${onIt[0]?.fraction}`);
  check('named so the user knows what they hit', onIt[0]!.name === 'Round 72"');

  // Sharing an edge is what a tidy plan looks like.
  const beside = box(6, 0, 6, 6);
  check('objects that only touch are not overlapping', findOverlaps(beside, [table]).length === 0);
  const clear = box(20, 20, 6, 6);
  check('and objects nowhere near each other are not either', findOverlaps(clear, [table]).length === 0);

  // A clip below the threshold is routine in a tight room.
  const clipped = box(5.8, 0, 6, 6);
  check('a slight clip is left alone', findOverlaps(clipped, [table]).length === 0, JSON.stringify(findOverlaps(clipped, [table])));

  // Measuring against the SMALLER object is what makes one threshold work for
  // a laptop and for a seating bank.
  const bank = at(2, 'Seating bank', 0, 0, 100, 60);
  const laptop = box(10, 10, 1, 1);
  const onBank = findOverlaps(laptop, [bank]);
  check('a small object fully inside a huge one still reports', onBank.length === 1, JSON.stringify(onBank));
  check('as fully buried, not as a rounding error', onBank[0]!.fraction === 1, `${onBank[0]?.fraction}`);

  // Deepest first: the thing most buried is what is being asked about.
  const many = findOverlaps(box(0, 0, 6, 6), [at(3, 'Half', 3, 0, 6, 6), at(4, 'All', 0, 0, 6, 6)]);
  check('the deepest overlap is reported first', many[0]!.name === 'All', many.map((m) => m.name).join(', '));
  check('and the rest follow', many.length === 2);

  check('nothing overlapping says nothing', describeOverlap([]) === '');
  check('one overlap names it', /Round 72/.test(describeOverlap(onIt)), describeOverlap(onIt));
  check('several are counted', /and 1 other/.test(describeOverlap(many)), describeOverlap(many));
}

console.log('\nintersection\n');
{
  check('a miss is null', intersection(box(0, 0, 1, 1), box(5, 5, 1, 1)) === null);
  check('a shared edge is null, not a zero-area box', intersection(box(0, 0, 1, 1), box(1, 0, 1, 1)) === null);
  const shared = intersection(box(0, 0, 4, 4), box(2, 2, 4, 4));
  check('a real overlap returns the shared rectangle', !!shared && shared.minX === 2 * F && shared.maxX === 4 * F, JSON.stringify(shared));
}

console.log('\nmoving beside\n');
{
  const table = box(0, 0, 6, 6);

  // Half over the left edge slides left, not across.
  const subject = box(-2, 2, 4, 2);
  const nudge = besidePosition(subject, [table]);
  check('it slides the short way out', nudge?.direction === 'left', JSON.stringify(nudge));
  check('and only far enough to clear', nudge?.dx === -2 * F, `${nudge?.dx}`);
  check('without moving on the other axis', nudge?.dy === 0);

  // The result really is clear.
  const after = {
    minX: subject.minX + nudge!.dx, maxX: subject.maxX + nudge!.dx,
    minY: subject.minY + nudge!.dy, maxY: subject.maxY + nudge!.dy,
  };
  check('the moved object no longer overlaps', intersection(after, table) === null);

  // A gap so the footprints do not share an edge.
  const spaced = besidePosition(subject, [table], 6);
  check('a gap can be asked for', spaced!.dx < nudge!.dx, `${spaced?.dx} vs ${nudge?.dx}`);

  check('nothing to clear means no move', besidePosition(box(20, 20, 2, 2), []) === null);

  // Boxed in: silence is the honest answer, because the tool cannot know which
  // neighbour is the one to disturb. The ring has to actually enclose — four
  // separate slabs leave corner gaps, and sliding out through one of those is a
  // real answer, which is why the first version of this test was wrong rather
  // than the code.
  const trapped = box(4, 4, 2, 2);
  // Wide enough that no escape is short: the object is 2ft, and `besidePosition`
  // will not travel more than three times that, so the neighbours have to reach
  // further than 6ft in every direction or "leaving the ring" is a real answer.
  const ring = [
    box(-20, -6, 60, 10),  // above
    box(-20, 6, 60, 10),   // below
    box(-20, 4, 24, 2),    // left
    box(6, 4, 24, 2),      // right
  ];
  check('a boxed-in object reports no way out', besidePosition(trapped, ring) === null, JSON.stringify(besidePosition(trapped, ring)));

  // The room is a limit: sliding through a wall is not a fix.
  const nearWall = box(-2, 2, 4, 2);
  const room = box(-2, -10, 40, 40);
  const inside = besidePosition(nearWall, [table], 0, room);
  check(
    'it will not push an object through the room wall',
    inside === null || inside.direction !== 'left',
    JSON.stringify(inside),
  );

  // Not "beside" if it means throwing the object across the plan. A chair in
  // the MIDDLE of a 200ft bank has no "next to" worth offering — every way out
  // is a hundred feet. (Clipping its edge is different, and does get a nudge:
  // that is the case just above.)
  const buried = box(100, 100, 2, 2);
  const huge = box(0, 0, 200, 200);
  check('it will not fling a buried object clear of a huge one', besidePosition(buried, [huge]) === null, JSON.stringify(besidePosition(buried, [huge])));
  // …but an object merely clipping that same edge still slides out.
  const clipping = box(-1, 100, 2, 2);
  const slid = besidePosition(clipping, [huge]);
  check('while one clipping its edge still slides out', slid?.direction === 'left', JSON.stringify(slid));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
