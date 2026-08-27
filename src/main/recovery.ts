/** Crash-recovery journal for dirty plans and gear lists. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { atomicWriteFile, atomicWriteJson } from './storage.js';

export type RecoveryKind = 'plan' | 'gear';

export interface RecoveryEntry {
  format: 'groundplan-recovery';
  version: 1;
  id: string;
  kind: RecoveryKind;
  displayName: string;
  sourcePath?: string;
  /** SHA-256 of the source file before the unsaved edits began. */
  sourceDigest?: string;
  dataFile: string;
  updatedAt: string;
  byteLength: number;
}

function idFor(kind: RecoveryKind, key: string): string {
  return `${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function safeExtension(kind: RecoveryKind, sourcePath?: string): string {
  if (kind === 'gear') return '.gear.json';
  const extension = sourcePath ? extname(sourcePath).toLowerCase() : '';
  return /^\.[a-z0-9]{2,8}$/.test(extension) ? extension : '.rv4';
}

export async function writeRecovery(
  root: string,
  kind: RecoveryKind,
  key: string,
  displayName: string,
  data: Uint8Array | string,
  sourcePath?: string,
  sourceDigest?: string,
): Promise<RecoveryEntry> {
  await mkdir(root, { recursive: true });
  const id = idFor(kind, key);
  const dataFile = `${id}${safeExtension(kind, sourcePath)}`;
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  const entry: RecoveryEntry = {
    format: 'groundplan-recovery',
    version: 1,
    id,
    kind,
    displayName: displayName.trim() || basename(sourcePath ?? '') || 'Recovered work',
    sourcePath,
    sourceDigest:
      sourceDigest && /^[a-f0-9]{64}$/i.test(sourceDigest)
        ? sourceDigest.toLowerCase()
        : undefined,
    dataFile,
    updatedAt: new Date().toISOString(),
    byteLength: bytes.byteLength,
  };
  await atomicWriteFile(join(root, dataFile), bytes);
  await atomicWriteJson(join(root, `${id}.json`), entry);
  return entry;
}

/** Optional plan sidecars journaled beside a recovery entry so room/meta/links survive. */
export type PlanRecoverySidecar = 'companion' | 'dimensions' | 'links';

export function recoverySidecarPath(root: string, id: string, kind: PlanRecoverySidecar): string {
  return join(root, `${id}.${kind}.json`);
}

export async function writePlanRecoverySidecars(
  root: string,
  id: string,
  sidecars: Partial<Record<PlanRecoverySidecar, unknown>>,
): Promise<void> {
  if (!/^(plan|gear)-[a-f0-9]{24}$/.test(id)) return;
  await mkdir(root, { recursive: true });
  for (const kind of ['companion', 'dimensions', 'links'] as const) {
    const value = sidecars[kind];
    if (value === undefined) continue;
    await atomicWriteJson(recoverySidecarPath(root, id, kind), value);
  }
}

export async function readPlanRecoverySidecar(
  root: string,
  id: string,
  kind: PlanRecoverySidecar,
): Promise<unknown | null> {
  if (!/^(plan|gear)-[a-f0-9]{24}$/.test(id)) return null;
  const path = recoverySidecarPath(root, id, kind);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function removePlanRecoverySidecars(root: string, id: string): Promise<void> {
  await Promise.all(
    (['companion', 'dimensions', 'links'] as const).map((kind) =>
      rm(recoverySidecarPath(root, id, kind), { force: true }),
    ),
  );
}

function validEntry(value: unknown): RecoveryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<RecoveryEntry>;
  if (
    entry.format !== 'groundplan-recovery' ||
    entry.version !== 1 ||
    typeof entry.id !== 'string' ||
    !/^(plan|gear)-[a-f0-9]{24}$/.test(entry.id) ||
    (entry.kind !== 'plan' && entry.kind !== 'gear') ||
    typeof entry.displayName !== 'string' ||
    typeof entry.dataFile !== 'string' ||
    basename(entry.dataFile) !== entry.dataFile ||
    typeof entry.updatedAt !== 'string' ||
    typeof entry.byteLength !== 'number'
  ) {
    return null;
  }
  if (
    entry.sourceDigest !== undefined &&
    (typeof entry.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sourceDigest))
  ) {
    return null;
  }
  return entry as RecoveryEntry;
}

export async function listRecoveries(root: string): Promise<RecoveryEntry[]> {
  if (!existsSync(root)) return [];
  const entries: RecoveryEntry[] = [];
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = validEntry(JSON.parse(await readFile(join(root, name), 'utf8')) as unknown);
      if (entry && existsSync(join(root, entry.dataFile))) entries.push(entry);
    } catch {
      // A broken journal entry must not block the rest of the recovery list.
    }
  }
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Hides recovery entries for documents that are already open.
 *
 * The journal is still written while the user edits, so a crash can recover
 * the work on the next launch. Listing that same entry under "Recover unsaved
 * work" while its document is the one on screen reads as lost work.
 */
export function hideActiveRecoveries(
  entries: RecoveryEntry[],
  activeIds: Iterable<string>,
): RecoveryEntry[] {
  const hide = new Set(activeIds);
  if (hide.size === 0) return entries;
  return entries.filter((entry) => !hide.has(entry.id));
}

export async function readRecovery(
  root: string,
  id: string,
): Promise<{ entry: RecoveryEntry; data: Buffer }> {
  if (!/^(plan|gear)-[a-f0-9]{24}$/.test(id)) throw new Error('invalid recovery identifier');
  const entry = validEntry(JSON.parse(await readFile(join(root, `${id}.json`), 'utf8')) as unknown);
  if (!entry || entry.id !== id) throw new Error('recovery record is damaged');
  return { entry, data: await readFile(join(root, entry.dataFile)) };
}

export async function removeRecovery(root: string, id: string): Promise<void> {
  if (!/^(plan|gear)-[a-f0-9]{24}$/.test(id)) return;
  try {
    const { entry } = await readRecovery(root, id);
    await rm(join(root, entry.dataFile), { force: true });
  } catch {
    // The metadata may be the only surviving half.
  }
  await removePlanRecoverySidecars(root, id);
  await rm(join(root, `${id}.json`), { force: true });
}

export function recoveryId(kind: RecoveryKind, key: string): string {
  return idFor(kind, key);
}
