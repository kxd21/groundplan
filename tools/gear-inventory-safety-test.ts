/**
 * Hermetic regression coverage for the Gear and Equipment Library repositories.
 *
 *   npx tsx tools/gear-inventory-safety-test.ts
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  locateGearItem,
  nextId,
  removeGearItem,
  restoreGearItem,
  updateGearItem,
  type GearList,
} from '../src/gear/model.js';
import {
  GEAR_FILE_VERSION,
  loadGearFileWithStatus,
  migrateGearLists,
  saveGearFile,
} from '../src/gear/store.js';
import {
  isReconcileReportCurrent,
  reconcile,
} from '../src/gear/reconcile.js';
import type { Scene } from '../src/format/scene.js';
import {
  emptyInventory,
  mergeItems,
  removeInventoryItem,
  restoreInventoryItem,
  updateInventoryItem,
} from '../src/inventory/model.js';
import {
  INVENTORY_ASSET_DIRECTORY,
  INVENTORY_FILE_VERSION,
  loadInventory,
  loadInventoryWithStatus,
  migrateInventory,
  saveInventory,
} from '../src/inventory/store.js';

const checks: Array<[name: string, ok: boolean, detail?: string]> = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail]);
};

function fixtureList(): GearList {
  return {
    id: nextId('l'),
    revision: 0,
    jobNumber: 'JOB-42',
    title: 'Hermetic show',
    departments: [
      {
        id: nextId('d'),
        name: 'Lighting',
        items: [
          {
            id: nextId(),
            quantity: 2,
            description: 'Profile fixture',
            children: [
              {
                id: nextId(),
                quantity: 2,
                description: 'Lens tube',
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function fixtureScene(): Scene {
  return {
    primitives: [],
    extent: null,
    roomExtent: null,
    counts: {},
    inventory: [{ name: 'Profile fixture', count: 2 }],
    title: 'Hermetic plan',
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'groundplan-safety-'));
  try {
    const generated = new Set(Array.from({ length: 2_000 }, () => nextId()));
    check('UUID gear IDs do not collide', generated.size === 2_000, String(generated.size));
    check('UUID gear IDs are opaque rather than counters', [...generated].every((id) => /^g_[0-9a-f-]{36}$/.test(id)));

    const legacy = {
      format: 'groundplan-gear',
      version: 1,
      lists: [
        {
          title: 'Legacy',
          departments: [
            {
              id: 'd1',
              name: 'Video',
              items: [
                { id: 'g1', quantity: 1, description: 'Projector A', children: [] },
                { id: 'g1', quantity: 1, description: 'Projector B', children: [] },
              ],
            },
          ],
        },
      ],
    };
    const firstMigration = migrateGearLists(structuredClone(legacy.lists), 1);
    const secondMigration = migrateGearLists(structuredClone(legacy.lists), 1);
    const firstIds = [
      firstMigration.lists[0].id,
      firstMigration.lists[0].departments[0].id,
      ...firstMigration.lists[0].departments[0].items.map((item) => item.id),
    ];
    const secondIds = [
      secondMigration.lists[0].id,
      secondMigration.lists[0].departments[0].id,
      ...secondMigration.lists[0].departments[0].items.map((item) => item.id),
    ];
    check('legacy duplicate IDs are repaired', new Set(firstIds).size === firstIds.length);
    check('legacy ID repair is deterministic', JSON.stringify(firstIds) === JSON.stringify(secondIds));
    check(
      'migration reports duplicate repair',
      firstMigration.report.repairedDuplicateIds === 1 && firstMigration.report.assignedIds === 1,
      JSON.stringify(firstMigration.report),
    );

    const ambiguous = fixtureList();
    ambiguous.departments[0].items.push({
      ...ambiguous.departments[0].items[0],
      children: [],
    });
    check('ambiguous IDs cannot target an arbitrary row', locateGearItem(ambiguous, ambiguous.departments[0].items[0].id) === null);

    const editable = fixtureList();
    const itemId = editable.departments[0].items[0].id;
    const invalid = updateGearItem(editable, itemId, { quantity: -1 });
    check('invalid quantity is rejected without revision change', !invalid.ok && editable.revision === 0);
    const updated = updateGearItem(editable, itemId, { description: '  Updated profile  ' });
    check(
      'validated edit trims content and advances revision',
      updated.ok && updated.changed && editable.departments[0].items[0].description === 'Updated profile' && editable.revision === 1,
    );
    const removed = removeGearItem(editable, itemId);
    check('delete returns an undo token', removed.ok && removed.changed && editable.departments[0].items.length === 0);
    if (removed.ok && removed.changed) {
      const restored = restoreGearItem(editable, removed.value);
      check('delete token restores hierarchy and position', restored.ok && editable.departments[0].items[0].id === itemId);
    }

    const gearPath = join(dir, 'show.gear.json');
    const original = fixtureList();
    await saveGearFile(gearPath, [original]);
    const firstGearPayload = JSON.parse(await readFile(gearPath, 'utf8')) as { version: number };
    check('gear saves schema v2', firstGearPayload.version === GEAR_FILE_VERSION);
    original.departments[0].items[0].description = 'Changed after backup';
    await saveGearFile(gearPath, [original]);
    await writeFile(gearPath, '{"truncated":', 'utf8');
    await writeFile(`${gearPath}.bak`, '{"also-truncated":', 'utf8');
    const recoveredGear = await loadGearFileWithStatus(gearPath);
    check('gear recovers through the rotating backup chain', recoveredGear.recoveredFromBackup);
    check(
      'gear recovery returns the previous valid generation',
      recoveredGear.lists[0].departments[0].items[0].description === 'Profile fixture',
    );

    const inventory = emptyInventory();
    const jobA = { id: 'show-a', type: 'gear-pdf' as const, jobId: '42', sourcePath: '/jobs/42/list.pdf' };
    const jobB = { id: 'show-b', type: 'gear-pdf' as const, jobId: '43', sourcePath: '/jobs/43/list.pdf' };
    mergeItems(inventory, [{ name: 'Projector', quantity: 2 }], new Date('2026-01-01T00:00:00Z'), jobA);
    const repeated = mergeItems(
      inventory,
      [{ name: 'Projector', quantity: 2 }],
      new Date('2026-01-02T00:00:00Z'),
      jobA,
    );
    check(
      're-importing one job does not inflate timesSeen',
      inventory.items[0].timesSeen === 1 && repeated.duplicateSightings === 1,
      `${inventory.items[0].timesSeen}`,
    );
    mergeItems(inventory, [{ name: 'Projector', quantity: 3 }], new Date('2026-01-03T00:00:00Z'), jobB);
    check(
      'a distinct job increments timesSeen and peak quantity',
      inventory.items[0].timesSeen === 2 && inventory.items[0].peakQuantity === 3,
    );
    check('inventory retains a distinct import ledger', inventory.imports.length === 2);
    const badSize = updateInventoryItem(inventory, inventory.items[0].id, { width: 120 });
    check('inventory dimensions reject partial edits', !badSize.ok);
    const inventoryEdit = updateInventoryItem(inventory, inventory.items[0].id, {
      name: '  Projector XL  ',
      width: 240,
      height: 120,
    });
    check(
      'inventory edit validates and commits as one mutation',
      inventoryEdit.ok &&
        inventoryEdit.changed &&
        inventory.items[0].name === 'Projector XL' &&
        inventory.items[0].sizeSource === 'user',
    );
    const removedInventory = removeInventoryItem(inventory, inventory.items[0].id);
    check('inventory delete returns an undo token', removedInventory.ok && inventory.items.length === 0);
    if (removedInventory.ok && removedInventory.changed) {
      const restored = restoreInventoryItem(inventory, removedInventory.value);
      check('inventory delete token restores the row', restored.ok && inventory.items.length === 1);
    }
    const identityProbe = emptyInventory();
    mergeItems(identityProbe, [{ name: 'Identity probe' }]);
    const firstInventoryId = identityProbe.items[0].id;
    removeInventoryItem(identityProbe, firstInventoryId);
    mergeItems(identityProbe, [{ name: 'Identity probe' }]);
    check(
      'inventory UUID is not recycled after delete and re-create',
      identityProbe.items[0].id !== firstInventoryId,
    );

    const v1Inventory = {
      format: 'groundplan-inventory',
      version: 1,
      items: [
        {
          id: 'duplicate',
          name: 'Chair',
          sizeSource: 'unknown',
          timesSeen: 7,
          peakQuantity: 20,
          addedAt: '2020-01-01T00:00:00.000Z',
        },
        {
          id: 'duplicate',
          name: 'Table',
          sizeSource: 'unknown',
          timesSeen: 3,
          peakQuantity: 5,
          addedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
    };
    const migratedInventory = migrateInventory(v1Inventory);
    check('inventory v1 counts survive migration', migratedInventory.inventory.items[0].timesSeen === 7);
    check(
      'inventory migration repairs duplicate IDs',
      new Set(migratedInventory.inventory.items.map((item) => item.id)).size === 2,
    );

    const sourceSymbol = join(dir, 'external-symbol.rv4');
    await writeFile(sourceSymbol, new Uint8Array([0x52, 0x56, 0x34, 0x00, 0x01, 0x02]));
    mergeItems(inventory, [{ name: 'Managed lectern', symbolPath: sourceSymbol }]);
    const inventoryFile = join(dir, 'inventory.json');
    await saveInventory(inventoryFile, inventory);
    const managed = inventory.items.find((item) => item.name === 'Managed lectern');
    check(
      'symbol source is copied into managed storage',
      !!managed?.symbolPath &&
        existsSync(managed.symbolPath) &&
        managed.symbolPath.startsWith(resolve(dir, INVENTORY_ASSET_DIRECTORY)),
      managed?.symbolPath,
    );
    const savedInventory = JSON.parse(await readFile(inventoryFile, 'utf8')) as {
      version: number;
      items: Array<{ name: string; symbolPath?: string }>;
    };
    check('inventory saves schema v3', savedInventory.version === INVENTORY_FILE_VERSION);
    check(
      'managed symbol path is portable on disk',
      savedInventory.items.find((item) => item.name === 'Managed lectern')?.symbolPath?.startsWith(
        `${INVENTORY_ASSET_DIRECTORY}/`,
      ) === true,
    );
    await rm(sourceSymbol);
    const reloadedInventory = await loadInventory(inventoryFile);
    const reloadedSymbol = reloadedInventory.items.find((item) => item.name === 'Managed lectern');
    check('managed symbol still works after source removal', !!reloadedSymbol?.symbolPath && existsSync(reloadedSymbol.symbolPath));

    reloadedInventory.items[0].notes = 'newer generation';
    await saveInventory(inventoryFile, reloadedInventory);
    await writeFile(inventoryFile, '{"truncated":', 'utf8');
    await writeFile(`${inventoryFile}.bak`, '{"also-truncated":', 'utf8');
    const recoveredInventory = await loadInventoryWithStatus(inventoryFile);
    check('inventory recovers through the rotating backup chain', recoveredInventory.recoveredFromBackup);
    check('inventory recovery preserves rows', recoveredInventory.inventory.items.length === inventory.items.length);

    const plan = fixtureScene();
    const reconcileList = fixtureList();
    const report = reconcile(reconcileList, plan, {
      planId: 'plan-42',
      planRevision: 3,
      planPath: '/jobs/42/plan.rv4',
      comparedAt: '2026-01-01T00:00:00.000Z',
    });
    check(
      'reconcile carries plan and gear snapshot identity',
      report.identity.plan.id === 'plan-42' && report.identity.gear.id === reconcileList.id,
    );
    check(
      'reconcile snapshot is current for unchanged inputs',
      isReconcileReportCurrent(report, reconcileList, plan, {
        planId: 'plan-42',
        planRevision: 3,
        planPath: '/jobs/42/plan.rv4',
      }),
    );
    reconcileList.departments[0].items[0].quantity++;
    check(
      'reconcile snapshot becomes stale after a gear edit',
      !isReconcileReportCurrent(report, reconcileList, plan, {
        planId: 'plan-42',
        planRevision: 3,
        planPath: '/jobs/42/plan.rv4',
      }),
    );

    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'));
    check('atomic writers leave no temporary files', leftovers.length === 0, leftovers.join(', '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  let failures = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
  }
  console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
}

void main();
