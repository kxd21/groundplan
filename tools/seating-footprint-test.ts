/**
 * Confining seating to a set depth.
 *
 * The generator otherwise floods the whole room; a real house seats a defined
 * block (Card Party is 78 ft deep inside a 130 ft room). `clearances.depth`
 * stops the rows at that depth, so the count and footprint match the drawing
 * instead of doubling it.
 *
 *   npx tsx tools/seating-footprint-test.ts
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

console.log('confining the seating footprint\n');

const room = rectangularRoom(120 * F, 120 * F, 'Deep hall');
const bounds = roomBounds(room)!;
const focus = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY - 6 * F };

const full = solveSeating(createSeatingPlan('theatre', focus), room);
check('an unconfined field fills the room', full.seats.length > 0, `${full.seats.length}`);

const confined = createSeatingPlan('theatre', focus);
confined.clearances.depth = 40 * F; // seat only the front 40 ft
const shallow = solveSeating(confined, room);

check('a depth limit seats fewer', shallow.seats.length < full.seats.length, `${shallow.seats.length} vs ${full.seats.length}`);
check('and seats something', shallow.seats.length > 0, `${shallow.seats.length}`);

// No row should sit deeper than front clearance + depth (+ one row of slack).
// Depth is measured perpendicular from the focus (a wide row's edge seat is
// farther in a straight line but no deeper), which here is the +y axis.
const startDepth = confined.clearances.frontWall + confined.clearances.front;
const deepest = shallow.seats.reduce((m, s) => Math.max(m, s.y - focus.y), 0);
check(
  'no row runs past the set depth',
  deepest <= startDepth + 40 * F + confined.rowSpacing + 1,
  `deepest ${(deepest / F).toFixed(1)} ft, limit ${((startDepth + 40 * F + confined.rowSpacing) / F).toFixed(1)} ft`,
);

// depth of 0 is unchanged from the default.
const zero = createSeatingPlan('theatre', focus);
zero.clearances.depth = 0;
check('depth 0 fills the room like the default', solveSeating(zero, room).seats.length === full.seats.length);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
