/**
 * Placing a whole gear list onto the plan at once.
 *
 * A gear list is descriptions and quantities with no positions, so this lays
 * every drawable line in a staging grid — turning a 150-line manifest into 150
 * objects in one step instead of arming and clicking each. Cable and
 * consumables are skipped so they never become room-sized boxes.
 *
 *   npx tsx tools/gear-place-test.ts
 */

import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { createBlankPlan } from '../src/format/blank.js';
import { loadBuffer, walk } from '../src/format/index.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { placeGearList } from '../src/main/plan-model.js';
import type { GearList } from '../src/gear/model.js';
import type { Session } from '../src/main/session.js';

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

console.log('placing a gear list onto the plan\n');

const list: GearList = {
  title: 'Test pull',
  departments: [
    {
      id: 'd1',
      name: 'Lighting',
      items: [
        { id: 'a', quantity: 6, description: 'Leko Light', children: [] },
        { id: 'b', quantity: 4, description: 'Source 4 Par', children: [] },
        { id: 'c', quantity: 12, description: 'XLR Cable 25ft', children: [] }, // skipped: cable
        {
          id: 'p',
          quantity: 1,
          description: 'Dimmer Package',
          children: [
            { id: 'p1', quantity: 2, description: 'Riser 6x8', children: [] },
            { id: 'p2', quantity: 1, description: 'Please label all cases', children: [], note: true }, // skipped: note
          ],
        },
      ],
    },
  ],
};

const blank = createBlankPlan({ room: { width: 60 * F, depth: 40 * F } });
const original = blank.file!;
const doc = loadBuffer(original, 'gear.rv4').document;
const session = { loaded: { document: doc } } as unknown as Session;

const result = placeGearList(session, list);
check('the gear list is placed', result.ok, result.reason);

// 6 Leko + 4 Source 4 + 2 Riser = 12 objects. Cable and the note are skipped.
check('drawable quantities are placed and cable/notes skipped', result.placed === 12, `placed ${result.placed}`);

const lekos = [...walk(doc)].filter((n) => n.labels.includes('Leko Light')).length;
check('each item keeps its name in the inventory', lekos === 6, `${lekos} Leko`);
check('no cable was drawn', [...walk(doc)].every((n) => !n.labels.some((l) => /cable/i.test(l))));

// Footprint-aware staging: no two placed items overlap (a 6x8 riser must not
// land on a neighbour the way a fixed pitch would let it).
const placedShapes = [...walk(doc)].filter(
  (n) => n.cls === 'RVShape' && n.labels.some((l) => /leko|source 4|riser/i.test(l)),
);
const overlap = (a: (typeof placedShapes)[number], b: (typeof placedShapes)[number]) =>
  a.bounds.left < b.bounds.right && b.bounds.left < a.bounds.right && a.bounds.top < b.bounds.bottom && b.bounds.top < a.bounds.bottom;
let overlaps = 0;
for (let i = 0; i < placedShapes.length; i++) {
  for (let j = i + 1; j < placedShapes.length; j++) {
    if (overlap(placedShapes[i], placedShapes[j])) overlaps++;
  }
}
check('staged items do not overlap', overlaps === 0, `${overlaps} overlapping pairs`);

const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, 'gear.rv4').document;
check('the plan still parses cleanly', reread.warnings.length === 0, reread.warnings.slice(0, 2).join('; '));
check('and reproduces itself byte-for-byte', roundTrip(reread).identical);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
