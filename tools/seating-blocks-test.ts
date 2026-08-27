/**
 * Straight seating blocks side by side.
 *
 * A real house is a grid of blocks separated by aisles, not one slab or an
 * angled fan. `blocksAcross` splits the field into N straight blocks; this
 * checks that N blocks actually appear as N clusters with gaps, that the
 * default of one block is unchanged, and that adding aisles costs seats.
 *
 *   npx tsx tools/seating-blocks-test.ts
 */

import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { rectangularRoom, roomBounds } from '../src/format/room.js';
import { createSeatingPlan, solveSeating } from '../src/format/seating-plan.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

const F = UNITS_PER_FOOT;

console.log('seating blocks across\n');

const room = rectangularRoom(120 * F, 80 * F, 'Hall');
const bounds = roomBounds(room)!;
const focus = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - 6 * F };

/** Groups seat x-positions into clusters split by gaps wider than a seat pitch. */
function columns(xs: number[], gap: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  let clusters = sorted.length ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) clusters++;
  }
  return clusters;
}

const base = createSeatingPlan('theatre', focus);
const single = solveSeating(base, room);
check('a single field solves', single.seats.length > 0, `${single.seats.length}`);

// blocksAcross of 1 must equal the untouched default exactly.
const one = solveSeating({ ...createSeatingPlan('theatre', focus), blocksAcross: 1 }, room);
check(
  'blocksAcross = 1 is identical to the default',
  one.seats.length === single.seats.length,
  `${one.seats.length} vs ${single.seats.length}`,
);
check('the default field is one column', columns(single.seats.map((s) => s.x), 2 * base.seatSpacing) === 1);

// Four blocks: expect four clusters across, and fewer seats (aisles cost some).
const four = solveSeating({ ...createSeatingPlan('theatre', focus), blocksAcross: 4 }, room);
const cols = columns(four.seats.map((s) => s.x), 1.5 * base.seatSpacing);
check('four blocks produce four columns', cols === 4, `saw ${cols} columns`);
check('four blocks seat fewer than one solid field', four.seats.length < single.seats.length, `${four.seats.length} vs ${single.seats.length}`);
check('four blocks still seat most of the room', four.seats.length > single.seats.length * 0.6, `${four.seats.length}`);

// Eight blocks: eight clusters.
const eight = solveSeating({ ...createSeatingPlan('theatre', focus), blocksAcross: 8 }, room);
const cols8 = columns(eight.seats.map((s) => s.x), 1.5 * base.seatSpacing);
check('eight blocks produce eight columns', cols8 === 8, `saw ${cols8} columns`);

// A gridded house faces square: every chair shares one heading, not fanned onto
// the focus the way a single wide bank is.
const headings = new Set(four.seats.map((s) => Math.round(s.rotation * 1e6)));
check('blocks all face the same way (a clean grid)', headings.size === 1, `${headings.size} distinct headings`);
const fanned = new Set(single.seats.map((s) => Math.round(s.rotation * 1e6)));
check('a single wide bank still fans onto the focus', fanned.size > 1, `${fanned.size} headings`);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
