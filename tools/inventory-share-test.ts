/**
 * Inventory pack export/import — how one computer's stock reaches the shop.
 *
 *   npx tsx tools/inventory-share-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyInventory, type Inventory } from '../src/inventory/model.js';
import { saveInventory, inventoryPath } from '../src/inventory/store.js';
import { exportInventoryPack, importInventoryPack, PACK_MANIFEST } from '../src/inventory/share.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'groundplan-inv-share-'));
const machineA = join(root, 'a');
const machineB = join(root, 'b');
const packParent = join(root, 'usb');
mkdirSync(machineA, { recursive: true });
mkdirSync(machineB, { recursive: true });
mkdirSync(packParent, { recursive: true });

const fileA = inventoryPath(machineA);
const fileB = inventoryPath(machineB);

const inventoryA: Inventory = emptyInventory();
inventoryA.items.push({
  id: 'item_a',
  name: '60" Round',
  department: 'Furniture',
  width: 720,
  height: 720,
  sizeSource: 'user',
  timesSeen: 1,
  peakQuantity: 12,
  addedAt: new Date().toISOString(),
  tracedIcon: {
    width: 720,
    height: 720,
    paths: [{ points: [0, 0, 720, 0, 720, 720, 0, 720], closed: true }],
  },
});
inventoryA.items.push({
  id: 'item_b',
  name: 'Chiavari Chair',
  department: 'Furniture',
  width: 180,
  height: 180,
  sizeSource: 'parsed',
  timesSeen: 2,
  peakQuantity: 200,
  addedAt: new Date().toISOString(),
});

async function main(): Promise<void> {
  await saveInventory(fileA, inventoryA);

  const packDir = join(packParent, 'Groundplan-inventory-pack');
  const exported = await exportInventoryPack(fileA, inventoryA, packDir, 'Shop A');
  check('export writes a pack', exported.ok, exported.ok ? '' : exported.reason);
  check('manifest is present', existsSync(join(packDir, PACK_MANIFEST)));
  check('inventory.json is present', existsSync(join(packDir, 'inventory.json')));
  check('export counts both items', exported.ok && exported.items === 2, `${exported.ok ? exported.items : 0}`);

  const inventoryB = emptyInventory();
  inventoryB.items.push({
    id: 'item_local',
    name: 'Chiavari Chair',
    department: 'Furniture',
    width: 180,
    height: 180,
    sizeSource: 'user',
    timesSeen: 1,
    peakQuantity: 50,
    addedAt: new Date().toISOString(),
  });
  await saveInventory(fileB, inventoryB);

  const imported = await importInventoryPack(packDir, fileB, inventoryB);
  check('import merges the pack', imported.ok, imported.ok ? '' : imported.reason);
  check('new item is added', imported.ok && imported.added === 1, `${imported.ok ? imported.added : 0}`);
  check(
    'existing chair is updated, not duplicated',
    inventoryB.items.filter((i) => /chiavari/i.test(i.name)).length === 1,
  );
  check('round table arrived', inventoryB.items.some((i) => /round/i.test(i.name)));
  check('user size on chair is kept', inventoryB.items.find((i) => /chiavari/i.test(i.name))?.sizeSource === 'user');
  check('traced outline survived the trip', !!inventoryB.items.find((i) => /round/i.test(i.name))?.tracedIcon);

  const bogus = await importInventoryPack(join(root, 'missing'), fileB, inventoryB);
  check('a non-pack folder is refused', !bogus.ok);

  mkdirSync(join(root, 'not-a-pack'), { recursive: true });
  writeFileSync(join(root, 'not-a-pack', 'readme.txt'), 'nope');
  const refused = await importInventoryPack(join(root, 'not-a-pack'), fileB, inventoryB);
  check('a folder without inventory.json is refused', !refused.ok);

  rmSync(root, { recursive: true, force: true });

  console.log(
    `\n${failed === 0 ? 'all' : failed} inventory-share check${failed === 1 ? '' : 's'} ${failed === 0 ? 'passed' : 'failed'}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
