/**
 * Reading and writing gear lists.
 *
 * Imported lists are kept as JSON next to the job rather than written back to
 * PDF: the PDF is a printout from the rental system and is not the source of
 * truth. Groundplan owns the working copy — the prep ticks, quantity changes
 * and additions made while the show is being built.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { locateGearItem, type GearItem, type GearList } from './model.js';

export const GEAR_EXTENSION = '.gear.json';
export const GEAR_FILE_VERSION = 2;

interface GearFileV2 {
  format: 'groundplan-gear';
  version: 2;
  lists: GearList[];
}

export interface GearMigrationReport {
  fromVersion: 0 | 1 | 2;
  assignedIds: number;
  repairedDuplicateIds: number;
  initialisedRevisions: number;
  changed: boolean;
}

export interface GearLoadResult {
  lists: GearList[];
  migration: GearMigrationReport;
  recoveredFromBackup: boolean;
  sourcePath: string;
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

/**
 * Assigns durable identities while preserving every unique ID already present.
 * Repair IDs are based on hierarchy and content, so loading the same v1 file
 * produces the same migration instead of reshuffling React keys each time.
 */
export function migrateGearLists(
  value: unknown,
  fromVersion: 0 | 1 | 2 = 0,
): { lists: GearList[]; report: GearMigrationReport } {
  if (!Array.isArray(value)) throw new Error('gear file does not contain a list array');

  const used = new Set<string>();
  const report: GearMigrationReport = {
    fromVersion,
    assignedIds: 0,
    repairedDuplicateIds: 0,
    initialisedRevisions: 0,
    changed: false,
  };

  const assignId = (candidate: unknown, prefix: string, seed: string): string => {
    const existing = typeof candidate === 'string' ? candidate.trim() : '';
    if (existing && !used.has(existing)) {
      used.add(existing);
      return existing;
    }

    if (existing) report.repairedDuplicateIds++;
    else report.assignedIds++;
    report.changed = true;

    const base = `${prefix}_migrated_${stableHash(seed)}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return id;
  };

  const normaliseItem = (
    raw: unknown,
    listIndex: number,
    departmentIndex: number,
    path: number[],
  ): GearItem => {
    const item = record(raw);
    if (!item) throw new Error(`gear item ${path.join('.')} is not an object`);
    if (typeof item.description !== 'string') {
      throw new Error(`gear item ${path.join('.')} has no description`);
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity < 0) {
      throw new Error(`gear item ${path.join('.')} has an invalid quantity`);
    }
    if (item.children !== undefined && !Array.isArray(item.children)) {
      throw new Error(`gear item ${path.join('.')} has invalid children`);
    }

    const seed = [
      'item',
      listIndex,
      departmentIndex,
      path.join('.'),
      item.description,
      item.quantity,
    ].join('|');
    item.id = assignId(item.id, 'g', seed);
    item.quantity = Math.round(item.quantity);
    item.children = (item.children ?? []).map((child, index) =>
      normaliseItem(child, listIndex, departmentIndex, [...path, index]),
    );
    if (item.checked !== true) delete item.checked;
    if (item.note !== true) delete item.note;
    return item as unknown as GearItem;
  };

  const lists = value.map((rawList, listIndex) => {
    const list = record(rawList);
    if (!list) throw new Error(`gear list ${listIndex + 1} is not an object`);
    if (typeof list.title !== 'string' || !list.title.trim()) {
      throw new Error(`gear list ${listIndex + 1} has no title`);
    }
    if (!Array.isArray(list.departments)) {
      throw new Error(`gear list ${listIndex + 1} has invalid departments`);
    }

    list.id = assignId(
      list.id,
      'l',
      ['list', listIndex, list.jobNumber ?? '', list.title, list.location ?? ''].join('|'),
    );
    if (!Number.isSafeInteger(list.revision) || (list.revision as number) < 0) {
      list.revision = 0;
      report.initialisedRevisions++;
      report.changed = true;
    }

    list.departments = list.departments.map((rawDepartment, departmentIndex) => {
      const department = record(rawDepartment);
      if (!department) {
        throw new Error(`department ${departmentIndex + 1} in list ${listIndex + 1} is not an object`);
      }
      if (typeof department.name !== 'string' || !department.name.trim()) {
        throw new Error(`department ${departmentIndex + 1} in list ${listIndex + 1} has no name`);
      }
      if (!Array.isArray(department.items)) {
        throw new Error(`department "${department.name}" has invalid items`);
      }
      department.id = assignId(
        department.id,
        'd',
        ['department', listIndex, departmentIndex, department.name].join('|'),
      );
      department.items = department.items.map((item, itemIndex) =>
        normaliseItem(item, listIndex, departmentIndex, [itemIndex]),
      );
      return department;
    });
    return list as unknown as GearList;
  });

  return { lists, report };
}

function parseGearText(raw: string): { lists: GearList[]; report: GearMigrationReport } {
  const parsed = JSON.parse(raw) as unknown;
  const payload = record(parsed);
  if (!payload) throw new Error('not a Groundplan gear file');

  if (payload.format === 'groundplan-gear') {
    if (payload.version !== 1 && payload.version !== 2) {
      throw new Error(`unsupported Groundplan gear version ${String(payload.version)}`);
    }
    return migrateGearLists(payload.lists, payload.version);
  }

  // Tolerate a bare list, which is what an early export produced.
  if (Array.isArray(payload.departments)) return migrateGearLists([payload], 0);
  throw new Error('not a Groundplan gear file');
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
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows cannot fsync a directory handle. The file itself is still flushed,
  // and POSIX gets the stronger rename durability guarantee.
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort on platforms that do not expose directory handles.
  }
}

async function atomicWriteGear(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryExists = false;

  try {
    const handle = await open(temporary, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    let current: string | null = null;
    try {
      current = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (current !== null) {
      let currentIsValid = true;
      try {
        // Never replace the last-good backup with a corrupt primary.
        parseGearText(current);
      } catch {
        currentIsValid = false;
      }
      if (currentIsValid) {
        if (existsSync(backupPath(path))) {
          try {
            parseGearText(await readFile(backupPath(path), 'utf8'));
            await copyFile(backupPath(path), olderBackupPath(path));
            await syncFile(olderBackupPath(path));
          } catch {
            // Keep an older known-good generation rather than rotating a bad
            // backup over it.
          }
        }
        await copyFile(path, backupPath(path));
        await syncFile(backupPath(path));
      } else {
        await rename(path, quarantinePath(path));
      }
    }

    await rename(temporary, path);
    temporaryExists = false;
    await syncDirectory(dirname(path));
    if (!existsSync(backupPath(path))) {
      await copyFile(path, backupPath(path));
      await syncFile(backupPath(path));
    }
  } finally {
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

export async function saveGearFile(path: string, lists: GearList[]): Promise<void> {
  const migrated = migrateGearLists(lists, 2);
  const payload: GearFileV2 = {
    format: 'groundplan-gear',
    version: GEAR_FILE_VERSION,
    lists: migrated.lists,
  };
  await atomicWriteGear(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function loadGearFileWithStatus(path: string): Promise<GearLoadResult> {
  try {
    const loaded = parseGearText(await readFile(path, 'utf8'));
    return {
      lists: loaded.lists,
      recoveredFromBackup: false,
      sourcePath: path,
      migration: loaded.report,
    };
  } catch (primaryError) {
    const failures: string[] = [];
    for (const backup of [backupPath(path), olderBackupPath(path)]) {
      try {
        const loaded = parseGearText(await readFile(backup, 'utf8'));
        try {
          await rename(path, quarantinePath(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const payload: GearFileV2 = {
          format: 'groundplan-gear',
          version: GEAR_FILE_VERSION,
          lists: loaded.lists,
        };
        await atomicWriteGear(path, `${JSON.stringify(payload, null, 2)}\n`);
        return {
          lists: loaded.lists,
          recoveredFromBackup: true,
          sourcePath: backup,
          migration: loaded.report,
        };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new Error(`could not load gear file (${primaryMessage}); backup recovery failed (${failures.join('; ')})`);
  }
}

export async function loadGearFile(path: string): Promise<GearList[]> {
  return (await loadGearFileWithStatus(path)).lists;
}

/** Finds an item anywhere in a list, with its parent collection. */
export function locate(
  list: GearList,
  id: string,
): { item: GearItem; siblings: GearItem[]; index: number } | null {
  const found = locateGearItem(list, id);
  return found ? { item: found.item, siblings: found.siblings, index: found.index } : null;
}

/**
 * Ticks an item off, and its whole package with it.
 *
 * A package is not prepped until its pieces are, so checking the parent checks
 * the children — which is how a warehouse works through a pull sheet.
 */
export function setChecked(item: GearItem, checked: boolean): void {
  item.checked = checked || undefined;
  for (const child of item.children) setChecked(child, checked);
}
