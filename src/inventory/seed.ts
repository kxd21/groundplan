/**
 * The equipment library a brand-new install starts with.
 *
 * Without this, the first launch opens an empty inventory and an empty palette
 * — nothing to place until someone imports a plan or traces icons by hand. The
 * shared catalog already describes a full starter set of shapes, so a fresh
 * install copies that set into the private inventory once, the first time the
 * inventory file is absent. Later launches leave the user's library alone.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Inventory } from './model.js';
import { importInventoryPack } from './share.js';

export const STARTER_INVENTORY_DIRNAME = 'starter-inventory';

export interface StarterSeedResult {
  ok: boolean;
  seeded: boolean;
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

/**
 * Imports the bundled starter pack into an unused inventory.
 *
 * "Unused" means no items and no import history. A missing file qualifies, and
 * so does an empty `inventory.json` left by an earlier build that never seeded.
 * Once the user has imported anything (or kept the starter and later deleted
 * rows), the import ledger is non-empty and this leaves their library alone.
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
