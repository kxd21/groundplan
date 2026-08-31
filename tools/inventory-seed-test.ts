/**
 * First-launch starter inventory — shapes ready to place out of the box.
 *
 *   npx tsx tools/inventory-seed-test.ts
 */

import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyInventory } from '../src/inventory/model.js';
import { inventoryPath, loadInventory } from '../src/inventory/store.js';
import {
  findStarterInventoryDir,
  seedStarterInventory,
} from '../src/inventory/seed.js';
import { outlineFromTracedPaths, placeTracedIcon } from '../src/format/place.js';
import { createBlankPlan } from '../src/format/blank.js';
import { indexDocument } from '../src/format/edit.js';
import { loadBuffer } from '../src/format/index.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const repoStarter = findStarterInventoryDir({ appPath: process.cwd() });
check('starter pack is in the repo', repoStarter != null, repoStarter ?? 'missing');

if (repoStarter) {
  const pack = JSON.parse(readFileSync(join(repoStarter, 'inventory.json'), 'utf8')) as {
    items: Array<{ name: string; tracedIcon?: { paths: unknown[] } }>;
  };
  check('starter pack has a full set of items', pack.items.length >= 50, `${pack.items.length}`);
  check(
    'every starter item carries a placeable outline',
    pack.items.every((item) => (item.tracedIcon?.paths?.length ?? 0) > 0),
  );
}

const root = mkdtempSync(join(tmpdir(), 'groundplan-inv-seed-'));
const userData = join(root, 'user');
mkdirSync(userData, { recursive: true });
const file = inventoryPath(userData);

async function main(): Promise<void> {
  const first = emptyInventory();
  const seeded = await seedStarterInventory({
    inventoryFile: file,
    inventory: first,
    appPath: process.cwd(),
  });
  check('first launch seeds the inventory', seeded.ok && seeded.seeded, seeded.reason ?? '');
  check('seeded item count matches the pack', seeded.items >= 50, `${seeded.items}`);
  check('inventory file was written', existsSync(file));

  const loaded = await loadInventory(file);
  check('reloaded inventory keeps the shapes', loaded.items.length === seeded.items);
  check(
    'reloaded items still have traced icons',
    loaded.items.every((item) => (item.tracedIcon?.paths?.length ?? 0) > 0),
  );

  // An empty file with no import history (older builds) still gets the pack.
  const emptyFile = inventoryPath(join(root, 'empty-user'));
  mkdirSync(join(root, 'empty-user'), { recursive: true });
  writeFileSync(emptyFile, `${JSON.stringify(emptyInventory(), null, 2)}\n`, 'utf8');
  const fromEmptyFile = emptyInventory();
  const rescued = await seedStarterInventory({
    inventoryFile: emptyFile,
    inventory: fromEmptyFile,
    appPath: process.cwd(),
  });
  check('empty unused inventory.json is seeded too', rescued.ok && rescued.seeded, rescued.reason ?? '');

  // After a real seed, do not full-refill on the next launch.
  const second = await loadInventory(file);
  const before = second.items.length;
  const skipped = await seedStarterInventory({
    inventoryFile: file,
    inventory: second,
    appPath: process.cwd(),
  });
  check('a library that already has items is left alone by seed', skipped.ok && !skipped.seeded);
  check('skipped seed did not change item count', second.items.length === before);

  // User cleared every row but the import ledger remains — still their library.
  const cleared = await loadInventory(file);
  cleared.items = [];
  const notRefilled = await seedStarterInventory({
    inventoryFile: file,
    inventory: cleared,
    appPath: process.cwd(),
  });
  check('cleared library with import history is not refilled by seed', notRefilled.ok && !notRefilled.seeded);
  check('cleared library stays empty', cleared.items.length === 0);

  // Gear-only library (Windows upgrade path): no chairs → top-up seating shapes.
  const { ensureStarterInventory, hasPlaceableSeatingFurniture } = await import(
    '../src/inventory/seed.js'
  );
  const gearOnlyFile = inventoryPath(join(root, 'gear-only'));
  mkdirSync(join(root, 'gear-only'), { recursive: true });
  const gearOnly = emptyInventory();
  gearOnly.items.push({
    id: 'li_projector',
    name: 'LCD Projector',
    category: 'projector',
    view: 'plan',
    sizeSource: 'unknown',
    timesSeen: 1,
    legacyTimesSeen: 1,
    provenanceIds: ['gear-job:demo'],
    peakQuantity: 1,
    addedAt: new Date().toISOString(),
  });
  gearOnly.imports = [
    {
      id: 'gear-job:demo',
      type: 'gear-pdf',
      firstImportedAt: new Date().toISOString(),
      lastImportedAt: new Date().toISOString(),
    },
  ];
  writeFileSync(gearOnlyFile, `${JSON.stringify(gearOnly, null, 2)}\n`, 'utf8');
  check('gear-only library lacks seating furniture', !hasPlaceableSeatingFurniture(gearOnly));
  const topped = await ensureStarterInventory({
    inventoryFile: gearOnlyFile,
    inventory: gearOnly,
    appPath: process.cwd(),
  });
  check('gear-only library receives seating top-up', (topped.toppedUp ?? 0) > 0, String(topped.toppedUp));
  check('top-up adds placeable seating furniture', hasPlaceableSeatingFurniture(gearOnly));
  check('top-up keeps the projector row', gearOnly.items.some((item) => /projector/i.test(item.name)));

  const sample = loaded.items.find((item) => item.tracedIcon)!;
  const outline = outlineFromTracedPaths(sample.tracedIcon!.paths);
  check('traced paths convert to outline runs', outline.length > 0 && outline[0].length >= 2);

  const blank = createBlankPlan({ room: { width: 600, depth: 400 } });
  check('blank plan for placement is writable', blank.ok && !!blank.file, blank.reason ?? '');
  const doc = loadBuffer(blank.file!, 'seed-place.rv4').document;
  const placed = placeTracedIcon(
    doc,
    indexDocument(doc),
    sample.name,
    100,
    200,
    sample.tracedIcon!,
  );
  check('traced icon places onto a blank plan', placed.ok, placed.ok ? '' : placed.reason);
  check('placement created a shape id', (placed.created?.length ?? 0) > 0);

  rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall inventory seed checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
