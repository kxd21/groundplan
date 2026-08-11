/**
 * Durable storage for the company equipment library.
 *
 * The repository dual-reads legacy v1 files, validates and migrates them in
 * memory, keeps a last-good backup, quarantines corrupt primaries, and writes
 * through a uniquely named/fsynced temporary file. Drawn-symbol source files
 * are copied into a content-addressed directory beside the inventory so an
 * unplugged external drive does not turn placements into boxes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  emptyInventory,
  normaliseName,
  type Inventory,
  type InventoryImportRecord,
  type InventoryItem,
  type InventorySymbolAsset,
  type SizeSource,
} from './model.js';

export const INVENTORY_FILENAME = 'inventory.json';
export const INVENTORY_FILE_VERSION = 3;
export const INVENTORY_ASSET_DIRECTORY = 'inventory-assets';

/** What the file was called before the inventory got its current name. */
const LEGACY_FILENAMES = ['inventory-library.json', 'inventory-inventory.json'];
const FORMATS = ['groundplan-inventory', 'groundplan-library'] as const;
const SIZE_SOURCES = new Set<SizeSource>(['parsed', 'user', 'unknown', 'symbol']);

export interface InventoryMigrationReport {
  fromVersion: 1 | 2 | 3;
  assignedIds: number;
  repairedDuplicateIds: number;
  migratedSightings: number;
  changed: boolean;
}

export interface InventoryLoadResult {
  inventory: Inventory;
  migration: InventoryMigrationReport | null;
  recoveredFromBackup: boolean;
  sourcePath: string | null;
  warnings: string[];
}

export interface ManagedSymbolSummary {
  copied: number;
  reused: number;
  missing: number;
}

export function inventoryPath(userDataDir: string): string {
  return join(userDataDir, INVENTORY_FILENAME);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function normaliseImport(raw: unknown): InventoryImportRecord | null {
  const entry = record(raw);
  if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) return null;
  const now = new Date(0).toISOString();
  return {
    id: entry.id.trim(),
    type:
      entry.type === 'gear-pdf' ||
      entry.type === 'csv' ||
      entry.type === 'plan' ||
      entry.type === 'symbol-library' ||
      entry.type === 'spotlight-xml' ||
      entry.type === 'manual'
        ? entry.type
        : 'unknown',
    jobId: typeof entry.jobId === 'string' ? entry.jobId : undefined,
    label: typeof entry.label === 'string' ? entry.label : undefined,
    sourcePath: typeof entry.sourcePath === 'string' ? entry.sourcePath : undefined,
    firstImportedAt: typeof entry.firstImportedAt === 'string' ? entry.firstImportedAt : now,
    lastImportedAt: typeof entry.lastImportedAt === 'string' ? entry.lastImportedAt : now,
  };
}

function normaliseAsset(raw: unknown): InventorySymbolAsset | undefined {
  const asset = record(raw);
  if (
    !asset ||
    typeof asset.hash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(asset.hash) ||
    typeof asset.relativePath !== 'string'
  ) {
    return undefined;
  }
  const hash = asset.hash.toLowerCase();
  const relativePath = asset.relativePath.replace(/\\/g, '/');
  const fileName = relativePath.split('/').at(-1) ?? '';
  if (
    !relativePath.startsWith(`${INVENTORY_ASSET_DIRECTORY}/`) ||
    relativePath.split('/').includes('..') ||
    (fileName !== hash && !fileName.startsWith(`${hash}.`))
  ) {
    return undefined;
  }
  return {
    hash,
    relativePath,
    sourcePath: typeof asset.sourcePath === 'string' ? asset.sourcePath : undefined,
  };
}

/**
 * Migrates a parsed inventory without dropping unknown, forward-compatible
 * item fields. Unique existing IDs remain stable; missing/duplicate IDs get a
 * deterministic replacement based on name and position.
 */
export function migrateInventory(value: unknown): {
  inventory: Inventory;
  report: InventoryMigrationReport;
} {
  const payload = record(value);
  if (!payload || !FORMATS.includes(payload.format as (typeof FORMATS)[number])) {
    throw new Error('not a Groundplan inventory file');
  }
  if (payload.version !== 1 && payload.version !== 2 && payload.version !== 3) {
    throw new Error(`unsupported Groundplan inventory version ${String(payload.version)}`);
  }
  if (!Array.isArray(payload.items)) throw new Error('inventory items are not an array');

  const report: InventoryMigrationReport = {
    fromVersion: payload.version,
    assignedIds: 0,
    repairedDuplicateIds: 0,
    migratedSightings: 0,
    changed: payload.version !== INVENTORY_FILE_VERSION || payload.format !== 'groundplan-inventory',
  };

  const importsById = new Map<string, InventoryImportRecord>();
  if (Array.isArray(payload.imports)) {
    for (const raw of payload.imports) {
      const entry = normaliseImport(raw);
      if (!entry) {
        report.changed = true;
        continue;
      }
      const existing = importsById.get(entry.id);
      if (!existing) importsById.set(entry.id, entry);
      else {
        if (entry.firstImportedAt < existing.firstImportedAt) existing.firstImportedAt = entry.firstImportedAt;
        if (entry.lastImportedAt > existing.lastImportedAt) existing.lastImportedAt = entry.lastImportedAt;
        report.changed = true;
      }
    }
  }

  const usedIds = new Set<string>();
  const items = payload.items.map((raw, index) => {
    const item = record(raw);
    if (!item) throw new Error(`inventory item ${index + 1} is not an object`);
    if (typeof item.name !== 'string' || !item.name.trim()) {
      throw new Error(`inventory item ${index + 1} has no name`);
    }

    const existingId = typeof item.id === 'string' ? item.id.trim() : '';
    if (existingId && !usedIds.has(existingId)) {
      item.id = existingId;
      usedIds.add(existingId);
    } else {
      if (existingId) report.repairedDuplicateIds++;
      else report.assignedIds++;
      const base = `li_migrated_${stableHash(`${index}|${normaliseName(item.name)}`)}`;
      let id = base;
      let suffix = 2;
      while (usedIds.has(id)) id = `${base}-${suffix++}`;
      item.id = id;
      usedIds.add(id);
      report.changed = true;
    }

    item.name = item.name.trim();
    if (!SIZE_SOURCES.has(item.sizeSource as SizeSource)) {
      item.sizeSource = 'unknown';
      report.changed = true;
    }
    item.peakQuantity =
      typeof item.peakQuantity === 'number' && Number.isFinite(item.peakQuantity)
        ? Math.max(0, Math.round(item.peakQuantity))
        : 0;
    if (item.quantityOwned === null) {
      // Explicit clear is preserved.
    } else if (typeof item.quantityOwned === 'number' && Number.isFinite(item.quantityOwned)) {
      item.quantityOwned = Math.max(0, Math.round(item.quantityOwned));
    } else if (item.quantityOwned !== undefined) {
      delete item.quantityOwned;
      report.changed = true;
    }
    if (item.virtual !== undefined && typeof item.virtual !== 'boolean') {
      delete item.virtual;
      report.changed = true;
    }
    const oldTimes =
      typeof item.timesSeen === 'number' && Number.isFinite(item.timesSeen)
        ? Math.max(0, Math.round(item.timesSeen))
        : 0;
    const provenanceIds = [
      ...new Set(
        (Array.isArray(item.provenanceIds) ? item.provenanceIds : []).filter(
          (id): id is string => typeof id === 'string' && !!id.trim(),
        ),
      ),
    ];
    item.provenanceIds = provenanceIds;
    for (const provenanceId of provenanceIds) {
      if (importsById.has(provenanceId)) continue;
      const epoch = new Date(0).toISOString();
      importsById.set(provenanceId, {
        id: provenanceId,
        type: 'unknown',
        firstImportedAt: epoch,
        lastImportedAt: epoch,
      });
      report.changed = true;
    }
    if (
      typeof item.legacyTimesSeen !== 'number' ||
      !Number.isSafeInteger(item.legacyTimesSeen) ||
      item.legacyTimesSeen < 0
    ) {
      item.legacyTimesSeen = Math.max(0, oldTimes - provenanceIds.length);
      report.migratedSightings++;
      report.changed = true;
    }
    item.timesSeen = (item.legacyTimesSeen as number) + provenanceIds.length;
    item.addedAt = typeof item.addedAt === 'string' ? item.addedAt : new Date(0).toISOString();
    item.symbolAsset = normaliseAsset(item.symbolAsset);
    return item as unknown as InventoryItem;
  });

  return {
    inventory: {
      format: 'groundplan-inventory',
      version: INVENTORY_FILE_VERSION,
      items,
      imports: [...importsById.values()],
    },
    report,
  };
}

function parseInventoryText(raw: string): {
  inventory: Inventory;
  report: InventoryMigrationReport;
} {
  return migrateInventory(JSON.parse(raw) as unknown);
}

/**
 * Finds the inventory, including where an older build left it.
 *
 * The file has been renamed once; someone whose inventory took an afternoon to
 * build should not lose it to that.
 */
function resolveExisting(path: string): string | null {
  if (existsSync(path)) return path;
  // Only the real inventory has legacy names; any other path means what it says.
  if (basename(path) !== INVENTORY_FILENAME) return null;
  for (const legacy of LEGACY_FILENAMES) {
    const candidate = join(dirname(path), legacy);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function backupPath(path: string): string {
  return `${path}.bak`;
}

function olderBackupPath(path: string): string {
  return `${path}.bak.1`;
}

function quarantinePath(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
}

async function syncFile(path: string): Promise<void> {
  // Opened for writing, not reading. Windows refuses to flush a read-only
  // handle — `FlushFileBuffers` needs write access — so `'r'` here raised
  // EPERM on every save. POSIX is happy either way, which is why it went
  // unnoticed until this ran on Windows.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory handles cannot be fsynced on Windows.
  }
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryExists = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    temporaryExists = false;
    await syncDirectory(dirname(path));
  } finally {
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

function managedAssetPath(inventoryFile: string, asset: InventorySymbolAsset): string | null {
  const root = resolve(dirname(inventoryFile), INVENTORY_ASSET_DIRECTORY);
  const candidate = resolve(dirname(inventoryFile), asset.relativePath);
  if (!candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function portableRelativeAssetPath(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Copies every available external symbol source into managed, content-addressed
 * storage. It mutates symbolPath to the managed absolute path for the current
 * process while persisting a portable relative path.
 */
export async function manageInventorySymbols(
  inventoryFile: string,
  inventory: Inventory,
): Promise<ManagedSymbolSummary> {
  const summary: ManagedSymbolSummary = { copied: 0, reused: 0, missing: 0 };
  const cache = new Map<string, { asset: InventorySymbolAsset; absolutePath: string }>();
  const assetRoot = join(dirname(inventoryFile), INVENTORY_ASSET_DIRECTORY);

  for (const item of inventory.items) {
    const priorManaged = item.symbolAsset ? managedAssetPath(inventoryFile, item.symbolAsset) : null;
    if (priorManaged && existsSync(priorManaged)) {
      item.symbolPath = priorManaged;
      summary.reused++;
      continue;
    }

    const source = item.symbolPath ?? item.symbolAsset?.sourcePath;
    if (!source || !isAbsolute(source) || !existsSync(source)) {
      if (item.symbolPath || item.symbolAsset) summary.missing++;
      continue;
    }

    const cached = cache.get(source);
    if (cached) {
      item.symbolAsset = cached.asset;
      item.symbolPath = cached.absolutePath;
      summary.reused++;
      continue;
    }

    let body: Buffer;
    try {
      body = await readFile(source);
    } catch {
      summary.missing++;
      continue;
    }
    const hash = createHash('sha256').update(body).digest('hex');
    const extension = extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const destination = join(assetRoot, `${hash}${extension}`);
    if (!existsSync(destination)) {
      await atomicWrite(destination, body);
      summary.copied++;
    } else {
      summary.reused++;
    }

    const asset: InventorySymbolAsset = {
      hash,
      relativePath: portableRelativeAssetPath(relative(dirname(inventoryFile), destination)),
      sourcePath: item.symbolAsset?.sourcePath ?? source,
    };
    item.symbolAsset = asset;
    item.symbolPath = destination;
    cache.set(source, { asset, absolutePath: destination });
  }

  return summary;
}

function serialisableInventory(inventory: Inventory): Inventory {
  const copy = structuredClone(inventory);
  for (const item of copy.items) {
    if (item.symbolAsset) item.symbolPath = item.symbolAsset.relativePath;
  }
  return copy;
}

function hydrateManagedSymbols(path: string, inventory: Inventory, warnings: string[]): void {
  for (const item of inventory.items) {
    if (!item.symbolAsset) continue;
    const managed = managedAssetPath(path, item.symbolAsset);
    if (!managed) {
      warnings.push(`Ignored unsafe managed symbol path for "${item.name}".`);
      continue;
    }
    if (existsSync(managed)) item.symbolPath = managed;
    else {
      warnings.push(`Managed symbol is missing for "${item.name}".`);
      item.symbolPath = item.symbolAsset.sourcePath;
    }
  }
}

async function writeInventoryPayload(path: string, inventory: Inventory): Promise<void> {
  let current: string | null = null;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (current !== null) {
    let currentIsValid = true;
    try {
      parseInventoryText(current);
    } catch {
      currentIsValid = false;
    }
    if (currentIsValid) {
      if (existsSync(backupPath(path))) {
        try {
          parseInventoryText(await readFile(backupPath(path), 'utf8'));
          await copyFile(backupPath(path), olderBackupPath(path));
          await syncFile(olderBackupPath(path));
        } catch {
          // Do not rotate a corrupt backup over the older known-good copy.
        }
      }
      await copyFile(path, backupPath(path));
      await syncFile(backupPath(path));
    } else {
      await rename(path, quarantinePath(path));
    }
  }

  await atomicWrite(path, `${JSON.stringify(serialisableInventory(inventory), null, 2)}\n`);
  if (!existsSync(backupPath(path))) {
    await copyFile(path, backupPath(path));
    await syncFile(backupPath(path));
  }
}

export async function loadInventoryWithStatus(path: string): Promise<InventoryLoadResult> {
  const found = resolveExisting(path);
  if (!found) {
    return {
      inventory: emptyInventory(),
      migration: null,
      recoveredFromBackup: false,
      sourcePath: null,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  try {
    const loaded = parseInventoryText(await readFile(found, 'utf8'));
    hydrateManagedSymbols(found, loaded.inventory, warnings);
    // Carry an older filename forward under the current name on first read.
    if (found !== path) await saveInventory(path, loaded.inventory);
    return {
      inventory: loaded.inventory,
      migration: loaded.report,
      recoveredFromBackup: false,
      sourcePath: found,
      warnings,
    };
  } catch (primaryError) {
    const failures: string[] = [];
    for (const backup of [backupPath(found), olderBackupPath(found)]) {
      try {
        const loaded = parseInventoryText(await readFile(backup, 'utf8'));
        try {
          await rename(found, quarantinePath(found));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        hydrateManagedSymbols(found, loaded.inventory, warnings);
        await writeInventoryPayload(path, loaded.inventory);
        warnings.push('Recovered the equipment library from a last-good backup.');
        return {
          inventory: loaded.inventory,
          migration: loaded.report,
          recoveredFromBackup: true,
          sourcePath: backup,
          warnings,
        };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      await rename(found, quarantinePath(found));
    } catch {
      // Preserve the original load behaviour: app startup must still work.
    }
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    warnings.push(`Inventory could not be read (${primaryMessage}); backups failed (${failures.join('; ')}).`);
    return {
      inventory: emptyInventory(),
      migration: null,
      recoveredFromBackup: false,
      sourcePath: found,
      warnings,
    };
  }
}

export async function loadInventory(path: string): Promise<Inventory> {
  return (await loadInventoryWithStatus(path)).inventory;
}

export async function saveInventory(path: string, inventory: Inventory): Promise<void> {
  const migrated = migrateInventory(inventory);
  // Keep the object held by the main process in sync with migration repairs.
  inventory.format = migrated.inventory.format;
  inventory.version = migrated.inventory.version;
  inventory.items = migrated.inventory.items;
  inventory.imports = migrated.inventory.imports;
  await manageInventorySymbols(path, inventory);
  await writeInventoryPayload(path, inventory);
}
