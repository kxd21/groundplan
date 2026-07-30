/**
 * Virtual plan folders.
 *
 * These collections organise plans without moving the source files. A plan can
 * therefore appear in more than one folder while its Show link, dimensions,
 * and companion metadata stay beside the original file.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { atomicWriteJson } from './storage.js';

export const PLAN_FOLDER_FORMAT = 'groundplan-plan-folders';
export const PLAN_FOLDER_VERSION = 1;
const MAX_FOLDERS = 1_000;
const MAX_MEMBERSHIPS = 10_000;
const MAX_DEPTH = 8;

export interface PlanFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanFolderMembership {
  folderId: string;
  path: string;
  addedAt: string;
}

export interface PlanFolderLibrary {
  format: typeof PLAN_FOLDER_FORMAT;
  version: typeof PLAN_FOLDER_VERSION;
  folders: PlanFolder[];
  memberships: PlanFolderMembership[];
}

export interface LoadedPlanFolders {
  library: PlanFolderLibrary;
  warnings: string[];
}

export function emptyPlanFolders(): PlanFolderLibrary {
  return {
    format: PLAN_FOLDER_FORMAT,
    version: PLAN_FOLDER_VERSION,
    folders: [],
    memberships: [],
  };
}

export function clonePlanFolders(library: PlanFolderLibrary): PlanFolderLibrary {
  return structuredClone(library);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const cleaned = value.trim();
  if (cleaned.length > maximum) throw new Error(`${label} is too long`);
  return cleaned;
}

function optionalDate(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  return new Date(0).toISOString();
}

function parsePlanFolders(value: unknown): PlanFolderLibrary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('plan-folder data is not an object');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.format !== PLAN_FOLDER_FORMAT ||
    raw.version !== PLAN_FOLDER_VERSION ||
    !Array.isArray(raw.folders) ||
    !Array.isArray(raw.memberships)
  ) {
    throw new Error('plan-folder data is incomplete or unsupported');
  }
  if (raw.folders.length > MAX_FOLDERS || raw.memberships.length > MAX_MEMBERSHIPS) {
    throw new Error('plan-folder data exceeds its safe size limit');
  }

  const folders: PlanFolder[] = [];
  const folderIds = new Set<string>();
  for (const value of raw.folders) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const folder = value as Record<string, unknown>;
    const id = requiredString(folder.id, 'folder ID', 128);
    if (folderIds.has(id)) continue;
    folderIds.add(id);
    folders.push({
      id,
      name: requiredString(folder.name, 'folder name', 80),
      parentId: typeof folder.parentId === 'string' && folder.parentId.trim() ? folder.parentId : null,
      createdAt: optionalDate(folder.createdAt),
      updatedAt: optionalDate(folder.updatedAt),
    });
  }

  // Orphans become top-level folders. This makes a partially edited JSON file
  // usable without silently throwing away the user's folder.
  for (const folder of folders) {
    if (folder.parentId === folder.id || (folder.parentId && !folderIds.has(folder.parentId))) {
      folder.parentId = null;
    }
  }

  // Break any remaining parent cycle at the first folder encountered.
  for (const folder of folders) {
    const visited = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        folder.parentId = null;
        break;
      }
      visited.add(parentId);
      parentId = folders.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
  }

  const memberships: PlanFolderMembership[] = [];
  const membershipKeys = new Set<string>();
  for (const value of raw.memberships) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const membership = value as Record<string, unknown>;
    if (typeof membership.folderId !== 'string' || !folderIds.has(membership.folderId)) continue;
    if (typeof membership.path !== 'string' || !membership.path.trim()) continue;
    const path = resolve(membership.path);
    const key = `${membership.folderId}\0${path}`;
    if (membershipKeys.has(key)) continue;
    membershipKeys.add(key);
    memberships.push({
      folderId: membership.folderId,
      path,
      addedAt: optionalDate(membership.addedAt),
    });
  }

  return {
    format: PLAN_FOLDER_FORMAT,
    version: PLAN_FOLDER_VERSION,
    folders,
    memberships,
  };
}

async function readLibrary(path: string): Promise<PlanFolderLibrary> {
  return parsePlanFolders(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function corruptPath(path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path}.corrupt-${timestamp}-${randomUUID()}`;
}

export async function loadPlanFolders(path: string): Promise<LoadedPlanFolders> {
  if (!existsSync(path)) return { library: emptyPlanFolders(), warnings: [] };
  try {
    return { library: await readLibrary(path), warnings: [] };
  } catch (primaryError) {
    const backup = `${path}.bak`;
    if (existsSync(backup)) {
      try {
        const recovered = await readLibrary(backup);
        const quarantined = corruptPath(path);
        await rename(path, quarantined);
        await atomicWriteJson(path, recovered);
        return {
          library: recovered,
          warnings: [
            `Recovered plan folders from the last-good backup. The damaged file was kept as ${basename(quarantined)}.`,
          ],
        };
      } catch {
        // Fall through and preserve the damaged primary before starting empty.
      }
    }
    const quarantined = corruptPath(path);
    await rename(path, quarantined).catch(() => undefined);
    return {
      library: emptyPlanFolders(),
      warnings: [
        `Plan folders could not be read and were reset. The damaged file was kept as ${basename(quarantined)} (${String(primaryError)}).`,
      ],
    };
  }
}

export async function savePlanFolders(path: string, library: PlanFolderLibrary): Promise<void> {
  await atomicWriteJson(path, library, {
    backupPath: existsSync(path) ? `${path}.bak` : undefined,
  });
}

function requireFolder(library: PlanFolderLibrary, id: string): PlanFolder {
  const folder = library.folders.find((candidate) => candidate.id === id);
  if (!folder) throw new Error('that plan folder no longer exists');
  return folder;
}

function validateSiblingName(
  library: PlanFolderLibrary,
  name: string,
  parentId: string | null,
  exceptId?: string,
): string {
  const cleaned = requiredString(name, 'folder name', 80);
  if (
    library.folders.some(
      (folder) =>
        folder.id !== exceptId &&
        folder.parentId === parentId &&
        folder.name.localeCompare(cleaned, undefined, { sensitivity: 'accent' }) === 0,
    )
  ) {
    throw new Error(`a folder named “${cleaned}” already exists here`);
  }
  return cleaned;
}

export function createPlanFolder(
  library: PlanFolderLibrary,
  name: string,
  parentId: string | null,
  id: string = randomUUID(),
  now = new Date().toISOString(),
): PlanFolder {
  if (library.folders.length >= MAX_FOLDERS) throw new Error('the plan-folder limit has been reached');
  if (parentId) {
    requireFolder(library, parentId);
    let depth = 1;
    let ancestor = library.folders.find((folder) => folder.id === parentId);
    while (ancestor?.parentId) {
      depth++;
      ancestor = library.folders.find((folder) => folder.id === ancestor?.parentId);
    }
    if (depth >= MAX_DEPTH) throw new Error(`plan folders can be nested up to ${MAX_DEPTH} levels`);
  }
  const folder: PlanFolder = {
    id: requiredString(id, 'folder ID', 128),
    name: validateSiblingName(library, name, parentId),
    parentId,
    createdAt: now,
    updatedAt: now,
  };
  if (library.folders.some((candidate) => candidate.id === folder.id)) {
    throw new Error('that folder ID already exists');
  }
  library.folders.push(folder);
  return folder;
}

export function renamePlanFolder(
  library: PlanFolderLibrary,
  id: string,
  name: string,
  now = new Date().toISOString(),
): PlanFolder {
  const folder = requireFolder(library, id);
  folder.name = validateSiblingName(library, name, folder.parentId, id);
  folder.updatedAt = now;
  return folder;
}

export function removePlanFolder(
  library: PlanFolderLibrary,
  id: string,
): { folders: number; memberships: number } {
  requireFolder(library, id);
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of library.folders) {
      if (folder.parentId && removed.has(folder.parentId) && !removed.has(folder.id)) {
        removed.add(folder.id);
        changed = true;
      }
    }
  }
  const beforeMemberships = library.memberships.length;
  library.folders = library.folders.filter((folder) => !removed.has(folder.id));
  library.memberships = library.memberships.filter((membership) => !removed.has(membership.folderId));
  return {
    folders: removed.size,
    memberships: beforeMemberships - library.memberships.length,
  };
}

export function addPlansToFolder(
  library: PlanFolderLibrary,
  folderId: string,
  paths: string[],
  now = new Date().toISOString(),
): number {
  requireFolder(library, folderId);
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  const existing = new Set(
    library.memberships
      .filter((membership) => membership.folderId === folderId)
      .map((membership) => membership.path),
  );
  const additions = unique.filter((path) => !existing.has(path));
  if (library.memberships.length + additions.length > MAX_MEMBERSHIPS) {
    throw new Error('the plan-folder item limit has been reached');
  }
  library.memberships.push(
    ...additions.map((path) => ({
      folderId,
      path,
      addedAt: now,
    })),
  );
  return additions.length;
}

export function removePlanFromFolder(
  library: PlanFolderLibrary,
  folderId: string,
  path: string,
): boolean {
  requireFolder(library, folderId);
  const canonical = resolve(path);
  const before = library.memberships.length;
  library.memberships = library.memberships.filter(
    (membership) => membership.folderId !== folderId || membership.path !== canonical,
  );
  return library.memberships.length !== before;
}
