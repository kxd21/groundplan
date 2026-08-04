/**
 * Deep stress coverage for inventory correctness bugs found in audit:
 * pack export must not mutate live paths, rename keeps symbolName,
 * user maps survive harvest merge, duplicate is identity-safe.
 *
 *   npx tsx tools/inventory-stress-test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyInventory,
  mergeItems,
  updateInventoryItem,
  locateInventoryItem,
  type Inventory,
} from '../src/inventory/model.js';
import { chooseSymbol } from '../src/inventory/match.js';
import { saveInventory, inventoryPath, loadInventory } from '../src/inventory/store.js';
import { exportInventoryPack, importInventoryPack } from '../src/inventory/share.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'groundplan-inv-stress-'));
const machine = join(root, 'shop');
const packParent = join(root, 'usb');
const fakePlan = join(root, 'symbols.rv4');
mkdirSync(machine, { recursive: true });
mkdirSync(packParent, { recursive: true });
writeFileSync(fakePlan, 'not-a-real-plan');

async function main(): Promise<void> {
  const file = inventoryPath(machine);
  const inventory: Inventory = emptyInventory();

  // --- rename preserves symbol lookup name ---------------------------------
  inventory.items.push({
    id: 'proj_1',
    name: 'LCD Projector',
    department: 'AV',
    width: 180,
    height: 120,
    sizeSource: 'symbol',
    symbolPath: fakePlan,
    timesSeen: 3,
    peakQuantity: 4,
    addedAt: new Date().toISOString(),
  });
  const renamed = updateInventoryItem(inventory, 'proj_1', { name: 'Panasonic stand-in' });
  check('rename succeeds', renamed.ok && renamed.changed);
  check(
    'rename keeps original symbolName for placement',
    inventory.items[0].symbolName === 'LCD Projector',
    inventory.items[0].symbolName,
  );
  check('rename updates display name', inventory.items[0].name === 'Panasonic stand-in');

  // --- user map survives harvest merge -------------------------------------
  inventory.items.push({
    id: 'spk_1',
    name: 'QSC K12.2',
    department: 'Audio',
    width: 200,
    height: 200,
    sizeSource: 'user',
    symbolPath: join(root, 'user-picked.rv4'),
    symbolName: 'Speaker Box',
    mappedBy: 'user',
    mapReason: 'hand-picked',
    timesSeen: 1,
    peakQuantity: 8,
    addedAt: new Date().toISOString(),
  });
  writeFileSync(join(root, 'user-picked.rv4'), 'x');
  const harvestPath = join(root, 'other-job.rv4');
  writeFileSync(harvestPath, 'y');
  mergeItems(
    inventory,
    [
      {
        name: 'QSC K12.2',
        width: 210,
        height: 210,
        sizeSource: 'symbol',
        symbolPath: harvestPath,
        symbolName: 'Wrong Speaker',
      },
    ],
    new Date(),
    { type: 'plan', sourcePath: harvestPath, label: 'other' },
  );
  const speaker = inventory.items.find((i) => i.id === 'spk_1')!;
  check('user-mapped symbolPath is not overwritten by harvest', speaker.symbolPath?.endsWith('user-picked.rv4') === true);
  check('user-mapped symbolName is not overwritten by harvest', speaker.symbolName === 'Speaker Box');

  // --- pack export does not rewrite live symbolPath ------------------------
  await saveInventory(file, inventory);
  const beforeExport = inventory.items.map((i) => i.symbolPath);
  const packDir = join(packParent, 'Groundplan-inventory-pack');
  const exported = await exportInventoryPack(file, inventory, packDir, 'stress');
  check('export succeeds', exported.ok, exported.ok ? '' : exported.reason);
  check(
    'live inventory symbolPath unchanged after export',
    inventory.items.every((item, i) => item.symbolPath === beforeExport[i]),
    inventory.items.map((i) => i.symbolPath).join(' | '),
  );
  check('pack inventory.json exists', existsSync(join(packDir, 'inventory.json')));

  // Pack file itself may point at pack-relative managed paths — that is fine.
  const packText = readFileSync(join(packDir, 'inventory.json'), 'utf8');
  check('pack JSON is non-empty', packText.length > 50);

  // --- duplicate uses locateInventoryItem semantics ------------------------
  const ambig: Inventory = emptyInventory();
  ambig.items.push({
    id: 'dup',
    name: 'A',
    sizeSource: 'unknown',
    timesSeen: 1,
    peakQuantity: 0,
    addedAt: new Date().toISOString(),
  });
  ambig.items.push({
    id: 'dup',
    name: 'B',
    sizeSource: 'unknown',
    timesSeen: 1,
    peakQuantity: 0,
    addedAt: new Date().toISOString(),
  });
  check('locateInventoryItem refuses ambiguous legacy ids', locateInventoryItem(ambig, 'dup') === null);

  // --- chooseSymbol prefers symbolName on renamed rows ---------------------
  const choiceInv = emptyInventory();
  choiceInv.items.push({
    id: 'c1',
    name: 'LCD Projector',
    width: 180,
    height: 120,
    sizeSource: 'symbol',
    category: 'projector',
    symbolPath: fakePlan,
    symbolName: 'LCD Projector Outline',
    timesSeen: 5,
    peakQuantity: 2,
    addedAt: new Date().toISOString(),
  });
  const choice = chooseSymbol(choiceInv, 'Panasonic PT-RZ21KU Laser Projector');
  check('chooseSymbol finds a projector silhouette', !!choice);
  check(
    'chooseSymbol returns file-side symbolName',
    choice?.symbolName === 'LCD Projector Outline',
    choice?.symbolName,
  );

  // --- photo flag round-trip through list-style strip (unit) ---------------
  inventory.items[0].photoDataUrl = 'data:image/png;base64,aaaa';
  await saveInventory(file, inventory);
  const reloaded = await loadInventory(file);
  check('photo survives disk round-trip', !!reloaded.items.find((i) => i.id === 'proj_1')?.photoDataUrl);

  // Import pack into a fresh machine without clobbering user map on speaker
  // already covered; just ensure import still merges.
  const machineB = join(root, 'shop-b');
  mkdirSync(machineB, { recursive: true });
  const fileB = inventoryPath(machineB);
  const invB = emptyInventory();
  await saveInventory(fileB, invB);
  const imported = await importInventoryPack(packDir, fileB, invB);
  check('import pack into empty shop', imported.ok && imported.added >= 1, imported.ok ? String(imported.added) : imported.reason);

  // Stress: many merge cycles with photos
  const fat = emptyInventory();
  for (let i = 0; i < 200; i++) {
    mergeItems(
      fat,
      [
        {
          name: `Item ${i}`,
          width: 100 + (i % 40),
          height: 80 + (i % 30),
          sizeSource: 'parsed',
          photoDataUrl: i % 7 === 0 ? `data:image/png;base64,${'x'.repeat(200)}` : undefined,
        },
      ],
      new Date(),
      { type: 'manual', label: `batch-${i}` },
    );
  }
  check('200-item absorb completes', fat.items.length === 200);
  const photoCount = fat.items.filter((i) => i.photoDataUrl).length;
  check('photos attach on a subset', photoCount > 20, String(photoCount));

  // Re-merge should not duplicate
  for (let i = 0; i < 200; i++) {
    mergeItems(fat, [{ name: `Item ${i}`, quantity: 2 }], new Date(), {
      type: 'manual',
      id: `batch-re-${i}`,
      label: `re-${i}`,
    });
  }
  check('re-merge does not duplicate', fat.items.length === 200);

  rmSync(root, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? 'All' : failed} inventory stress check(s) ${failed === 0 ? 'passed' : 'failed'}.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
