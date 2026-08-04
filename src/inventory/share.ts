/**
 * Sharing a company inventory between installs.
 *
 * Groundplan has no cloud account: each machine owns its own inventory.json.
 * Shops move stock data the same way they move app updates — put a pack on a
 * USB stick (or shared folder), then import it on the other computers. Import
 * merges by name, so two people editing different items do not wipe each other.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { mergeItems, type Inventory, type InventoryItem } from './model.js';
import {
  INVENTORY_ASSET_DIRECTORY,
  INVENTORY_FILENAME,
  loadInventory,
  manageInventorySymbols,
  saveInventory,
} from './store.js';
import { atomicWriteJson } from '../main/storage.js';

export const PACK_MANIFEST = 'groundplan-inventory-pack.json';
export const PACK_FORMAT = 'groundplan-inventory-pack';
export const PACK_VERSION = 1;

export interface InventoryPackManifest {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  exportedAt: string;
  itemCount: number;
  assetCount: number;
  label?: string;
}

export interface PackExportResult {
  ok: true;
  path: string;
  items: number;
  assets: number;
}

export interface PackImportResult {
  ok: true;
  added: number;
  updated: number;
  assets: number;
  items: number;
}

function reason(message: string): { ok: false; reason: string } {
  return { ok: false, reason: message };
}

function assetAbsolute(inventoryFile: string, item: InventoryItem): string | null {
  if (item.symbolAsset?.relativePath) {
    const absolute = join(dirname(inventoryFile), item.symbolAsset.relativePath);
    if (existsSync(absolute)) return absolute;
  }
  if (item.symbolPath && existsSync(item.symbolPath)) return item.symbolPath;
  return null;
}

/** Writes the open inventory into a folder other machines can import. */
export async function exportInventoryPack(
  inventoryFile: string,
  inventory: Inventory,
  destinationDir: string,
  label?: string,
): Promise<PackExportResult | { ok: false; reason: string }> {
  if (!destinationDir) return reason('choose a folder for the inventory pack');

  await mkdir(destinationDir, { recursive: true });
  // Keep the live inventory's managed paths under userData. Export must never
  // rewrite in-memory symbolPath to the USB/pack folder (that would break
  // placement after the stick is ejected).
  await manageInventorySymbols(inventoryFile, inventory);
  const snapshot = structuredClone(inventory);

  const packInventoryPath = join(destinationDir, INVENTORY_FILENAME);
  await saveInventory(packInventoryPath, snapshot);

  const assetRoot = join(destinationDir, INVENTORY_ASSET_DIRECTORY);
  await mkdir(assetRoot, { recursive: true });

  let assets = 0;
  const seen = new Set<string>();
  for (const item of inventory.items) {
    const source = assetAbsolute(inventoryFile, item);
    if (!source || !item.symbolAsset) continue;
    const name = basename(item.symbolAsset.relativePath);
    if (seen.has(name)) continue;
    seen.add(name);
    const target = join(assetRoot, name);
    if (!existsSync(target)) {
      await copyFile(source, target);
      assets++;
    }
  }

  const manifest: InventoryPackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    itemCount: inventory.items.length,
    assetCount: assets,
    label: label?.trim() || undefined,
  };
  const manifestPath = join(destinationDir, PACK_MANIFEST);
  await atomicWriteJson(manifestPath, manifest, {
    backupPath: existsSync(manifestPath) ? `${manifestPath}.bak` : undefined,
  });

  return { ok: true, path: destinationDir, items: inventory.items.length, assets };
}

/**
 * Merges a pack folder into the local inventory.
 *
 * Assets are copied into this install's managed store first so symbol paths
 * resolve after the merge, even if the USB stick is ejected.
 */
export async function importInventoryPack(
  sourceDir: string,
  inventoryFile: string,
  inventory: Inventory,
): Promise<PackImportResult | { ok: false; reason: string }> {
  if (!sourceDir) return reason('choose an inventory pack folder');

  const packInventoryPath = join(sourceDir, INVENTORY_FILENAME);
  if (!existsSync(packInventoryPath)) {
    return reason('that folder is not an inventory pack (missing inventory.json)');
  }

  const manifestPath = join(sourceDir, PACK_MANIFEST);
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<InventoryPackManifest>;
      if (raw.format && raw.format !== PACK_FORMAT) {
        return reason('that folder is not a Groundplan inventory pack');
      }
    } catch {
      return reason('the inventory pack manifest could not be read');
    }
  }

  const incoming = await loadInventory(packInventoryPath);
  if (!incoming.items.length) return reason('that inventory pack has no items');

  // Point symbol paths at the pack's asset copies so manageInventorySymbols
  // can ingest them into this install.
  const packAssetRoot = join(sourceDir, INVENTORY_ASSET_DIRECTORY);
  for (const item of incoming.items) {
    if (!item.symbolAsset) continue;
    const packed = join(packAssetRoot, basename(item.symbolAsset.relativePath));
    if (existsSync(packed)) {
      item.symbolPath = packed;
      item.symbolAsset = {
        ...item.symbolAsset,
        sourcePath: item.symbolAsset.sourcePath ?? packed,
      };
    }
  }

  await manageInventorySymbols(inventoryFile, incoming);

  const summary = mergeItems(
    inventory,
    incoming.items.map((item) => ({
      name: item.name,
      department: item.department,
      quantity: item.peakQuantity || 1,
      width: item.width,
      height: item.height,
      sizeSource: item.sizeSource,
      notes: item.notes,
      symbolPath: item.symbolPath,
      symbolAsset: item.symbolAsset,
      symbolName: item.symbolName,
      mappedBy: item.mappedBy,
      mapReason: item.mapReason,
      tracedIcon: item.tracedIcon,
      photoDataUrl: item.photoDataUrl,
    })),
    new Date(),
    {
      id: `inventory-pack:${basename(sourceDir)}:${Date.now()}`,
      type: 'unknown',
      label: `Inventory pack from ${basename(sourceDir)}`,
      sourcePath: sourceDir,
    },
  );

  // Re-copy any assets that merge attached onto existing rows.
  await manageInventorySymbols(inventoryFile, inventory);
  await saveInventory(inventoryFile, inventory);

  return {
    ok: true,
    added: summary.added,
    updated: summary.updated,
    assets: incoming.items.filter((item) => item.symbolAsset).length,
    items: incoming.items.length,
  };
}
