/**
 * Several seating layouts on one plan.
 *
 * A region confines its seats to a zone and reserves the other regions, so a
 * main house and a VIP block coexist; re-placing one leaves the others alone.
 * This is what makes multitasking layouts possible.
 *
 *   npx tsx tools/seating-regions-test.ts
 */

import { UNITS_PER_FOOT as F } from '../src/format/rv.js';
import { rectangularRoom, roomBounds } from '../src/format/room.js';
import { createSeatingPlan, solveSeating } from '../src/format/seating-plan.js';
import { createBlankPlan } from '../src/format/blank.js';
import { loadBuffer, walk } from '../src/format/index.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { applySeating, removeSeatingRegion, resetPlanModel, seatingRegionNames } from '../src/main/plan-model.js';
import type { Session } from '../src/main/session.js';
import type { SeatingRequestView } from '../src/main/plan-model.js';

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

// --- format: a zone confines the solve to its rectangle -------------------
console.log('confining seating to a zone\n');
{
  const room = rectangularRoom(120 * F, 80 * F, 'Hall');
  const b = roomBounds(room)!;
  const focus = { x: (b.minX + b.maxX) / 2, y: b.minY - 6 * F };
  const plan = createSeatingPlan('theatre', focus);
  plan.area = { minX: b.minX + 10 * F, minY: b.minY + 10 * F, maxX: b.minX + 40 * F, maxY: b.minY + 50 * F };
  const solution = solveSeating(plan, room);
  check('a zone still seats', solution.seats.length > 0, `${solution.seats.length}`);
  check(
    'no seat falls outside the zone',
    solution.seats.every((s) => s.x >= plan.area!.minX - 1 && s.x <= plan.area!.maxX + 1 && s.y >= plan.area!.minY - 1 && s.y <= plan.area!.maxY + 1),
    'a seat escaped the zone',
  );
}

// --- plan model: regions coexist and re-place independently ----------------
console.log('\nmany layouts on one plan\n');

const blank = createBlankPlan({ room: { width: 120 * F, depth: 80 * F } });
const original = blank.file!;
const doc = loadBuffer(original, 'regions.rv4').document;
const session = { loaded: { document: doc } } as unknown as Session;

resetPlanModel();

const focusX = 60 * F;
const base: Omit<SeatingRequestView, 'regionId' | 'areaX' | 'areaY' | 'areaWidth' | 'areaHeight'> = {
  style: 'theatre',
  focusX,
  focusY: -6 * F,
  seatSpacing: 20 * 10,
  rowSpacing: 36 * 10,
  front: 6 * F,
};
const countChairs = () => [...walk(doc)].filter((n) => n.cls === 'RVShape' && n.labels.some((l) => /chair/i.test(l))).length;

// Region "House" fills the left half; "VIP" fills the right half.
const house = applySeating(session, { ...base, regionId: 'House', areaX: 0, areaY: -40 * F, areaWidth: 55 * F, areaHeight: 80 * F }, 'Chair 20" X 20"');
check('the house is placed', house.ok, house.reason);
const afterHouse = countChairs();

const vip = applySeating(session, { ...base, regionId: 'VIP', areaX: 65 * F, areaY: -40 * F, areaWidth: 55 * F, areaHeight: 80 * F }, 'Chair 20" X 20"');
check('the VIP block is placed', vip.ok, vip.reason);
const afterVip = countChairs();

check('placing VIP kept the house', afterVip > afterHouse, `${afterHouse} -> ${afterVip}`);
check('both regions are tracked', seatingRegionNames().sort().join(',') === 'House,VIP', seatingRegionNames().join(','));

// Re-placing the house replaces only the house; VIP is untouched.
const houseAgain = applySeating(session, { ...base, regionId: 'House', areaX: 0, areaY: -40 * F, areaWidth: 55 * F, areaHeight: 80 * F }, 'Chair 20" X 20"');
check('the house re-places', houseAgain.ok, houseAgain.reason);
const afterReplace = countChairs();
check('re-placing one region leaves the total stable (no duplication)', Math.abs(afterReplace - afterVip) <= 2, `${afterVip} -> ${afterReplace}`);

// Removing a region deletes only its own objects.
const rem = removeSeatingRegion(session, 'VIP');
check('the VIP layout is removed', rem.ok, rem.reason);
const afterRemove = countChairs();
check('removing VIP kept the house', afterRemove > 0 && afterRemove < afterReplace, `${afterReplace} -> ${afterRemove}`);
check('VIP is no longer tracked', !seatingRegionNames().includes('VIP'), seatingRegionNames().join(','));

// The plan is still a valid Room Viewer file.
const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, 'regions.rv4').document;
check('the multi-region plan parses cleanly', reread.warnings.length === 0, reread.warnings.slice(0, 2).join('; '));
check('and reproduces itself byte-for-byte', roundTrip(reread).identical);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
