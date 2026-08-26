/**
 * Named versions of a plan, kept beside the plan.
 *
 * Undo is bounded and dies with the session; crash recovery restores what you
 * were doing, not what you agreed to last Tuesday. Neither is a record. This
 * is: an explicit snapshot with a name somebody chose, so "Version 2 — client
 * revision" is a thing you can go back to and compare against.
 *
 * Snapshots are whole plan files rather than diffs. They are a few hundred
 * kilobytes, a show has a handful, and a snapshot you can open directly in the
 * app — or hand to somebody — is worth far more than the disk it costs.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface PlanVersion {
  id: string;
  /** What the user called it. */
  name: string;
  /** ISO timestamp of when it was taken. */
  savedAt: string;
  /** Bytes of the snapshot, for the listing. */
  size: number;
  /** Digest of the snapshot, so an unchanged save can be recognised. */
  digest: string;
}

interface VersionManifest {
  format: 'groundplan-versions';
  version: 1;
  versions: PlanVersion[];
}

const MANIFEST = 'versions.json';

/**
 * Where a plan's versions live.
 *
 * Beside the plan rather than in application data, because a plan that gets
 * copied to a USB stick or a shared drive should take its history with it —
 * the alternative is a history that silently belongs to one machine.
 */
export function versionDirFor(planPath: string): string {
  return join(dirname(planPath), `.${basename(planPath)}.versions`);
}

function manifestPath(planPath: string): string {
  return join(versionDirFor(planPath), MANIFEST);
}

function snapshotPath(planPath: string, id: string): string {
  return join(versionDirFor(planPath), `${id}.snapshot`);
}

function readManifest(planPath: string): VersionManifest {
  const path = manifestPath(planPath);
  if (!existsSync(path)) return { format: 'groundplan-versions', version: 1, versions: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VersionManifest;
    if (parsed?.format !== 'groundplan-versions' || !Array.isArray(parsed.versions)) {
      return { format: 'groundplan-versions', version: 1, versions: [] };
    }
    return parsed;
  } catch {
    // A corrupt manifest must not take the plan down with it. The snapshots are
    // still on disk and can be recovered by hand.
    return { format: 'groundplan-versions', version: 1, versions: [] };
  }
}

function writeManifest(planPath: string, manifest: VersionManifest): void {
  mkdirSync(versionDirFor(planPath), { recursive: true });
  writeFileSync(manifestPath(planPath), JSON.stringify(manifest, null, 2));
}

/**
 * Newest first, with a tiebreak that actually holds.
 *
 * `savedAt` is an ISO timestamp with millisecond resolution, and saving two
 * versions in the same millisecond is not exotic — it is what happens when
 * anything saves twice in a row, including this module's own tests, which went
 * red roughly one run in three. A tie left the order to sort stability, so
 * "newest" was undefined: `listVersions` could show them the wrong way round,
 * and `saveVersion` compares the incoming bytes against "the newest" to refuse
 * duplicates, so a tie could compare against the wrong snapshot.
 *
 * The manifest array is append-ordered, so a later index IS later in time. That
 * is the tiebreak.
 */
function newestFirst(versions: PlanVersion[]): PlanVersion[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((a, b) => b.version.savedAt.localeCompare(a.version.savedAt) || b.index - a.index)
    .map((entry) => entry.version);
}

/** Every saved version, newest first. */
export function listVersions(planPath: string): PlanVersion[] {
  return newestFirst(readManifest(planPath).versions);
}

/**
 * Saves the plan as it stands under a name.
 *
 * A save that is byte-identical to the newest version is refused rather than
 * silently duplicated: a version list where three entries are the same drawing
 * is worse than one where they are not, because it looks like work happened.
 */
export function saveVersion(
  planPath: string,
  bytes: Buffer,
  name: string,
): { ok: true; version: PlanVersion } | { ok: false; reason: string } {
  const label = name.trim();
  if (!label) return { ok: false, reason: 'Give the version a name.' };

  const manifest = readManifest(planPath);
  const digest = createHash('sha256').update(bytes).digest('hex');

  const newest = newestFirst(manifest.versions)[0];
  if (newest && newest.digest === digest) {
    return {
      ok: false,
      reason: `This is identical to "${newest.name}". Nothing has changed since that version.`,
    };
  }

  const version: PlanVersion = {
    id: randomUUID(),
    name: label,
    savedAt: new Date().toISOString(),
    size: bytes.byteLength,
    digest,
  };

  mkdirSync(versionDirFor(planPath), { recursive: true });
  writeFileSync(snapshotPath(planPath, version.id), bytes);
  manifest.versions.push(version);
  writeManifest(planPath, manifest);

  return { ok: true, version };
}

/** The bytes of one saved version, or null when it has gone missing. */
export function readVersion(planPath: string, id: string): Buffer | null {
  const path = snapshotPath(planPath, id);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function renameVersion(planPath: string, id: string, name: string): boolean {
  const label = name.trim();
  if (!label) return false;
  const manifest = readManifest(planPath);
  const version = manifest.versions.find((entry) => entry.id === id);
  if (!version) return false;
  version.name = label;
  writeManifest(planPath, manifest);
  return true;
}

export function deleteVersion(planPath: string, id: string): boolean {
  const manifest = readManifest(planPath);
  const index = manifest.versions.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  manifest.versions.splice(index, 1);
  writeManifest(planPath, manifest);
  rmSync(snapshotPath(planPath, id), { force: true });
  return true;
}

/**
 * Drops snapshots the manifest no longer lists.
 *
 * Only ever removes files whose names are not in the manifest, so a snapshot
 * that is still referenced cannot be collected by a bug here.
 */
export function pruneOrphans(planPath: string): number {
  const dir = versionDirFor(planPath);
  if (!existsSync(dir)) return 0;
  const known = new Set(readManifest(planPath).versions.map((entry) => `${entry.id}.snapshot`));
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === MANIFEST || known.has(entry)) continue;
    if (!entry.endsWith('.snapshot')) continue;
    rmSync(join(dir, entry), { force: true });
    removed++;
  }
  return removed;
}
