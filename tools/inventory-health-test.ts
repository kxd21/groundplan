/**
 * Inventory foundation checks — health, Insert coverage, recipe tracedIcon path.
 *
 *   npx tsx tools/inventory-health-test.ts
 */

import { readFileSync } from 'node:fs';
import { inventoryHealth } from '../src/inventory/health.js';
import { insertCatalogCoverage } from '../src/inventory/insert-catalog.js';
import { seedChairOutline } from '../src/inventory/layout-recipe.js';
import type { Inventory } from '../src/inventory/model.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const pack = JSON.parse(
  readFileSync('resources/starter-inventory/inventory.json', 'utf8'),
) as Inventory;

check('starter has items', pack.items.length >= 50, `${pack.items.length}`);
check(
  'starter items persist view=plan (or unset→plan)',
  pack.items.every((item) => !item.view || item.view === 'plan'),
);

const health = inventoryHealth(pack);
check('starter seating ready', health.seatingReady);
check('starter has placeable rows', health.placeable >= 40, `${health.placeable}`);
check('starter missing outlines is zero', health.missingOutline === 0, `${health.missingOutline}`);

const coverage = insertCatalogCoverage(
  pack.items.map((item) => ({ id: item.id, name: item.name, category: item.category ?? null })),
);
check(
  'Insert coverage ≥ 55%',
  coverage.matched / coverage.total >= 0.55,
  `${coverage.matched}/${coverage.total} missing=${coverage.missing.slice(0, 8).join(',')}`,
);
check(
  'round-60 matches Round 60"',
  !coverage.missing.includes('round-60'),
  coverage.missing.includes('round-60') ? 'still missing' : '',
);

const chair = pack.items.find(
  (item) => /Banquet Chair 18/i.test(item.name) || /Chair 20\.5/i.test(item.name),
);
check('starter has banquet chair', !!chair, chair?.name);
if (chair) {
  const outline = seedChairOutline(pack, chair.name);
  check(
    'seedChairOutline uses traced for starter chair',
    outline?.kind === 'traced',
    outline?.kind,
  );
}

const hospitalityNames = [
  'Banquet Chair 18" × 20"',
  'Chiavari Chair',
  'Folding Chair',
  'Cocktail Round 30"',
  'Highboy 30"',
  'Banquet Round 60"',
  'Banquet 6′ × 30″',
  'Classroom 6′ × 18″',
  'Half-Round 60″',
];
for (const name of hospitalityNames) {
  check(
    `hospitality item ${name}`,
    pack.items.some((item) => item.name === name),
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall inventory health checks passed');
