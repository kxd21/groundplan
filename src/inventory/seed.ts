/**
 * The equipment library a brand-new install starts with.
 *
 * Without this, the first launch opens an empty inventory and an empty palette
 * — nothing to place until someone imports a plan or traces icons by hand. The
 * shared catalog already describes a full starter set of shapes, so a fresh
 * install copies that set into the private inventory once, the first time the
 * inventory file is absent.
 *
 * Existing libraries that absorbed gear lists before the starter pack shipped
 * (common on Windows installs) can still lack placeable chairs and tables —
 * Place seating then stays disabled forever. `ensureStarterInventory` tops those
 * up without wiping user rows.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { classify } from './classify.js';
import {
  mergeItems,
  normaliseName,
  type Inventory,
  type InventoryItem,
} from './model.js';
import { importInventoryPack } from './share.js';
import { INVENTORY_ASSET_DIRECTORY, loadInventory, saveInventory } from './store.js';

export const STARTER_INVENTORY_DIRNAME = 'starter-inventory';

export interface StarterSeedResult {
  ok: boolean;
  seeded: boolean;
  /** Starter rows merged into an existing library that lacked seating shapes. */
  toppedUp?: number;
  items: number;
  reason?: string;
}

/**
 * Folders that may hold the bundled starter pack.
 *
 * Packaged builds put it under `process.resourcesPath` via electron-builder
 * `extraResources`. Development builds keep it in the repo under `resources/`.
 */
export function starterInventoryCandidates(roots: {
  resourcesPath?: string;
  appPath?: string;
}): string[] {
  const out: string[] = [];
  if (roots.resourcesPath) out.push(join(roots.resourcesPath, STARTER_INVENTORY_DIRNAME));
  if (roots.appPath) {
    out.push(join(roots.appPath, 'resources', STARTER_INVENTORY_DIRNAME));
    out.push(join(roots.appPath, '..', 'resources', STARTER_INVENTORY_DIRNAME));
  }
  return out;
}

export function findStarterInventoryDir(roots: {
  resourcesPath?: string;
  appPath?: string;
}): string | null {
  for (const dir of starterInventoryCandidates(roots)) {
    if (existsSync(join(dir, 'inventory.json'))) return dir;
  }
  return null;
}

function isPlanSeatingFurniture(item: Pick<InventoryItem, 'name' | 'category' | 'view'>): boolean {
  const inferred = classify(item.name);
  const view = item.view ?? inferred.view;
  if (view !== 'plan') return false;
  const category = item.category ?? inferred.category;
  return (
    category === 'chair' ||
    category === 'table-round' ||
    category === 'table-rect' ||
    (category === 'desk' && /\btable\b/i.test(item.name))
  );
}

/** True when the library can feed the seating chair/table pickers. */
export function hasPlaceableSeatingFurniture(inventory: Inventory): boolean {
  let chair = false;
  let table = false;
  for (const item of inventory.items) {
    if (!item.tracedIcon?.paths?.length) continue;
    if (!isPlanSeatingFurniture(item)) continue;
    const category = item.category ?? classify(item.name).category;
    if (category === 'chair') chair = true;
    else table = true;
    if (chair && table) return true;
  }
  return false;
}

/**
 * Imports the bundled starter pack into an unused inventory.
 *
 * "Unused" means no items and no import history. A missing file qualifies, and
 * so does an empty `inventory.json` left by an earlier build that never seeded.
 * Once the user has imported anything (or kept the starter and later deleted
 * rows), the import ledger is non-empty and this leaves their library alone —
 * unless `ensureStarterInventory` tops up missing seating shapes.
 */
export async function seedStarterInventory(options: {
  inventoryFile: string;
  inventory: Inventory;
  resourcesPath?: string;
  appPath?: string;
}): Promise<StarterSeedResult> {
  const unused =
    options.inventory.items.length === 0 && (options.inventory.imports?.length ?? 0) === 0;
  if (!unused) {
    return { ok: true, seeded: false, items: options.inventory.items.length };
  }

  const starterDir = findStarterInventoryDir({
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
  });
  if (!starterDir) {
    return {
      ok: false,
      seeded: false,
      items: 0,
      reason: 'the starter equipment pack is not bundled with this build',
    };
  }

  const imported = await importInventoryPack(starterDir, options.inventoryFile, options.inventory);
  if (!imported.ok) {
    return { ok: false, seeded: false, items: 0, reason: imported.reason };
  }

  return { ok: true, seeded: true, items: imported.items };
}

/**
 * Full seed when unused; otherwise merge missing starter furniture so Place
 * seating has chairs and tables with real outlines.
 */
export async function ensureStarterInventory(options: {
  inventoryFile: string;
  inventory: Inventory;
  resourcesPath?: string;
  appPath?: string;
}): Promise<StarterSeedResult> {
  const seeded = await seedStarterInventory(options);
  if (!seeded.ok) return seeded;
  if (seeded.seeded) return seeded;

  // Intentionally empty libraries (user cleared every row) stay empty.
  if (options.inventory.items.length === 0) {
    return { ok: true, seeded: false, toppedUp: 0, items: 0 };
  }

  if (hasPlaceableSeatingFurniture(options.inventory)) {
    return { ok: true, seeded: false, toppedUp: 0, items: options.inventory.items.length };
  }

  const starterDir = findStarterInventoryDir({
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
  });
  if (!starterDir) {
    return {
      ok: false,
      seeded: false,
      items: options.inventory.items.length,
      reason: 'the starter equipment pack is not bundled with this build',
    };
  }

  const starter = await loadInventory(join(starterDir, 'inventory.json'));
  const byName = new Map(options.inventory.items.map((item) => [normaliseName(item.name), item]));
  const incoming = starter.items
    .filter((item) => item.tracedIcon?.paths?.length)
    .filter((item) => {
      // Prefer seating + doors; also fill any starter row the library lacks so
      // Insert / Place gear keep working on older Windows installs.
      const existing = byName.get(normaliseName(item.name));
      if (!existing) return true;
      return !existing.tracedIcon?.paths?.length;
    })
    .map((item) => ({
      name: item.name,
      department: item.department,
      quantity: item.peakQuantity || 1,
      width: item.width,
      height: item.height,
      sizeSource: item.sizeSource,
      notes: item.notes,
      symbolPath: item.symbolPath,
      symbolAsset: item.symbolAsset
        ? {
            ...item.symbolAsset,
            // Never carry a Mac absolute path into a Windows user library.
            sourcePath: undefined,
          }
        : undefined,
      symbolName: item.symbolName,
      mappedBy: item.mappedBy,
      mapReason: item.mapReason,
      tracedIcon: item.tracedIcon,
      category: item.category,
      view: item.view,
    }));

  if (!incoming.length) {
    return { ok: true, seeded: false, toppedUp: 0, items: options.inventory.items.length };
  }

  const summary = mergeItems(options.inventory, incoming, new Date(), {
    id: 'starter-topup:seating-furniture',
    type: 'unknown',
    label: 'Starter seating furniture',
    sourcePath: starterDir,
  });

  // Point door symbols at managed or bundled assets — never keep a dead
  // absolute path from another machine.
  const userAssetRoot = join(dirname(options.inventoryFile), INVENTORY_ASSET_DIRECTORY);
  const bundledAssetRoot = join(starterDir, INVENTORY_ASSET_DIRECTORY);
  for (const item of options.inventory.items) {
    if (!item.symbolAsset?.relativePath) {
      if (item.symbolPath && !existsSync(item.symbolPath)) delete item.symbolPath;
      continue;
    }
    const leaf = basename(item.symbolAsset.relativePath);
    const managed = join(userAssetRoot, leaf);
    const bundled = join(bundledAssetRoot, leaf);
    if (existsSync(managed)) item.symbolPath = managed;
    else if (existsSync(bundled)) {
      item.symbolPath = bundled;
      item.symbolAsset = { ...item.symbolAsset, sourcePath: bundled };
    } else if (item.symbolPath && !existsSync(item.symbolPath)) {
      delete item.symbolPath;
    }
  }

  await saveInventory(options.inventoryFile, options.inventory);
  return {
    ok: true,
    seeded: false,
    toppedUp: summary.added + summary.updated,
    items: options.inventory.items.length,
  };
}

/**
 * Merge the full starter pack into an existing library (user-initiated).
 * Does not wipe rows — fills missing names and empty outlines.
 */
export async function mergeStarterInventory(options: {
  inventoryFile: string;
  inventory: Inventory;
  resourcesPath?: string;
  appPath?: string;
}): Promise<StarterSeedResult> {
  const starterDir = findStarterInventoryDir({
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
  });
  if (!starterDir) {
    return {
      ok: false,
      seeded: false,
      items: options.inventory.items.length,
      reason: 'the starter equipment pack is not bundled with this build',
    };
  }

  const unused =
    options.inventory.items.length === 0 && (options.inventory.imports?.length ?? 0) === 0;
  if (unused) {
    return seedStarterInventory(options);
  }

  const imported = await importInventoryPack(starterDir, options.inventoryFile, options.inventory);
  if (!imported.ok) {
    return {
      ok: false,
      seeded: false,
      items: options.inventory.items.length,
      reason: imported.reason,
    };
  }
  return {
    ok: true,
    seeded: false,
    toppedUp: imported.added + imported.updated,
    items: options.inventory.items.length,
  };
}
