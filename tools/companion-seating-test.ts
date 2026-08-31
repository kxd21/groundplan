/**
 * Smoke: companion seating spine parse + round-trip fields.
 *   npx tsx tools/companion-seating-test.ts
 */

import { createCompanion, parseCompanion, parseCompanionSeating } from '../src/format/companion.js';
import type { RVDocument } from '../src/format/rv.js';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const fakeDoc = { source: Buffer.from('test-archive') } as unknown as RVDocument;
const companion = createCompanion(fakeDoc, 'imperial');
companion.seating = {
  style: 'theatre',
  chairName: '18"x18"',
  tableName: 'Round 60',
  focusX: 100,
  focusY: -200,
  seatSpacing: 200,
  front: 960,
  stagger: true,
  seatsPerTable: 8,
  nodeIds: [11, 12, 13],
  banks: [{ id: 'bank-1', label: 'Theatre', ids: [11, 12, 13] }],
  chairs: 3,
  tables: 0,
  clearances: {
    front: 960,
    side: 480,
    wing: 480,
    rear: 480,
    centreAisle: 0,
    perimeter: 480,
    aisle: 0,
    frontWall: 0,
  },
};

const parsed = parseCompanionSeating(companion.seating);
check('parseCompanionSeating accepts spine', !!parsed);
check('style', parsed?.style === 'theatre');
check('chairName', parsed?.chairName === '18"x18"');
check('nodeIds length', parsed?.nodeIds.length === 3);
check('banks', parsed?.banks[0]?.ids.length === 3);
check('clearances.front', parsed?.clearances?.front === 960);

check('rejects missing chair', parseCompanionSeating({ style: 'theatre', focusX: 0, focusY: 0, nodeIds: [] }) == null);
check('rejects bad style', parseCompanionSeating({ ...companion.seating, style: 'nope' }) == null);

const roundTrip = parseCompanion(JSON.parse(JSON.stringify(companion)));
check('parseCompanion keeps seating', !!roundTrip?.seating);
check('round-trip chairs', roundTrip?.seating?.chairs === 3);
check('round-trip managed ids', roundTrip?.seating?.nodeIds.join(',') === '11,12,13');

console.log(failed ? `${failed} failed` : '11/11 checks passed');
process.exit(failed ? 1 : 0);
