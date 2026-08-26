import { filterSeatingAssets } from '../src/renderer/src/seating-options.js';

const inventory = [
  { name: 'Chair - Banquet', category: 'chair', view: 'plan' },
  { name: 'Chair - Banquet (FV)', category: 'chair', view: 'front' },
  { name: '18"x18" - No Detail' },
  { name: 'Round 60"', category: 'table-round', view: 'plan' },
  { name: 'Round 60" (SV)', category: 'table-round', view: 'side' },
  { name: 'Buffet Line 12' },
  { name: '20K Projector', category: 'projector', view: 'plan' },
  { name: 'Box Truss', category: 'truss', view: 'plan' },
];

const chairs = filterSeatingAssets(inventory, 'chair').map((item) => item.name);
const tables = filterSeatingAssets(inventory, 'table').map((item) => item.name);

const expectedChairs = ['Chair - Banquet', '18"x18" - No Detail'];
const expectedTables = ['Round 60"', 'Buffet Line 12'];

if (JSON.stringify(chairs) !== JSON.stringify(expectedChairs)) {
  throw new Error(`chair picker leaked or dropped assets: ${JSON.stringify(chairs)}`);
}
if (JSON.stringify(tables) !== JSON.stringify(expectedTables)) {
  throw new Error(`table picker leaked or dropped assets: ${JSON.stringify(tables)}`);
}
if (chairs.some((name) => /\((?:FV|SV|RV|R)\)$/i.test(name)) || tables.some((name) => /\((?:FV|SV|RV|R)\)$/i.test(name))) {
  throw new Error('an elevation leaked into a top-down seating picker');
}

console.log('seating picker: plan-view chairs and tables only');
