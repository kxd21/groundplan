/**
 * Smoke: hang plot filter + CSV.
 *   npx tsx tools/hang-plot-test.ts
 */

import type { PlacedItem } from '../src/format/definition.js';
import { hangPlotItems, hangPlotToCsv } from '../src/format/hang-plot.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { scheduleToCsv, type Schedule } from '../src/format/schedule.js';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const floor: PlacedItem = {
  nodeId: 1,
  key: 'chair@0,0',
  name: 'Chair',
  x: 0,
  y: 0,
  rotation: 0,
  width: 18,
  depth: 18,
  spec: { name: 'Chair', category: 'chair' } as PlacedItem['spec'],
  elevation: 0,
  top: 36,
  obstruction: 'partial',
  seats: 1,
  estimated: true,
};

const truss: PlacedItem = {
  ...floor,
  nodeId: 2,
  key: 'truss@120,240',
  name: '12" Box Truss',
  x: 120,
  y: 240,
  elevation: 16 * UNITS_PER_FOOT,
  top: 16 * UNITS_PER_FOOT + 12,
  seats: 0,
};

const hang = hangPlotItems([floor, truss]);
check('filters floor items', hang.length === 1 && hang[0]?.name === '12" Box Truss');
const csv = hangPlotToCsv([floor, truss]);
check('csv has AFF header', csv.startsWith('Item,X (ft)'));
check('csv includes truss AFF', csv.includes('16.00'));
check('csv omits floor chair', !csv.includes('Chair'));

const schedule: Schedule = {
  total: 1,
  groups: [
    {
      name: '12" Box Truss',
      count: 1,
      entries: [
        {
          key: 'truss@12,24',
          name: '12" Box Truss',
          x: 12 * 10,
          y: 24 * 10,
          width: 120,
          height: 12,
          rotation: 0,
        },
      ],
    },
  ],
};
const withAff = scheduleToCsv(schedule, new Map([['truss@12,24', 16 * UNITS_PER_FOOT]]));
check('schedule CSV has AFF column', withAff.includes('AFF (ft)'));
check('schedule CSV AFF value', withAff.includes('16.00'));

console.log(failed ? `${failed} failed` : '6/6 checks passed');
process.exit(failed ? 1 : 0);
