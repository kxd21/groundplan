/**
 * Installing a catalog release, and surviving it going wrong.
 *
 * The rule the whole design hangs on: the catalog in use is never modified. An
 * update is staged beside it, validated in full, and only then swapped in by a
 * rename — which is atomic within a directory. A crash, a bad package or a
 * failed validation therefore cannot leave a half-applied catalog, because the
 * live file was never opened for writing.
 *
 *     catalog/
 *       current.json    ← what the application reads
 *       incoming.json   ← staged; the update is built here
 *       previous.json   ← last known good, kept for rollback
 *
 * The private inventory is not in this directory and is never passed to any
 * function here. An update cannot damage company data because it has no path to
 * it, rather than because it promises not to.
 */

import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { applyDelta, type CatalogDelta } from './delta.js';
import { sha256 } from './manifest.js';
import { emptyCatalog, validateCatalog, type Catalog } from './model.js';

export const CURRENT = 'current.json';
export const INCOMING = 'incoming.json';
export const PREVIOUS = 'previous.json';

export interface CatalogPaths {
  root: string;
  current: string;
  incoming: string;
  previous: string;
}

export function catalogPaths(root: string): CatalogPaths {
  return {
    root,
    current: join(root, CURRENT),
    incoming: join(root, INCOMING),
    previous: join(root, PREVIOUS),
  };
}

/**
 * Takes an exclusive install lock.
 *
 * `open` with `wx` fails if the file exists, which makes creating it an atomic
 * claim. A stale lock from a process that crashed mid-install would otherwise
 * block updating forever, so one older than a couple of minutes is taken over.
 */
async function acquireLock(paths: CatalogPaths): Promise<(() => Promise<void>) | null> {
  const lockPath = join(paths.root, 'install.lock');
  await mkdir(paths.root, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid), 'utf8');
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch {
      try {
        const { mtimeMs } = statSync(lockPath);
        if (Date.now() - mtimeMs > 120_000) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // The lock vanished between the failed claim and the stat; try again.
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Write to a unique temporary file, then rename. Never a partial file. */
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    // Flush before the rename, so a power loss cannot leave a renamed but
    // empty file where a working catalog used to be.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readCatalog(path: string): Promise<Catalog | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Catalog;
    return validateCatalog(parsed).ok ? parsed : null;
  } catch {
    return null;
  }
}

/** The installed catalog, or an empty one when there is nothing usable yet. */
export async function loadInstalled(paths: CatalogPaths): Promise<Catalog> {
  return (await readCatalog(paths.current)) ?? emptyCatalog();
}

export interface InstallOutcome {
  ok: boolean;
  reason?: string;
  version?: string;
  added: number;
  updated: number;
  deprecated: number;
  removed: number;
  /** True when a failure caused the previous catalog to be put back. */
  rolledBack?: boolean;
}

const NOTHING = { added: 0, updated: 0, deprecated: 0, removed: 0 };

export interface InstallInput {
  paths: CatalogPaths;
  /** Raw downloaded package bytes, still unverified. */
  packageBytes: Uint8Array;
  /** Hash the signed manifest said this package would have. */
  expectedSha256: string;
  kind: 'delta' | 'full';
}

/**
 * Verifies and installs a downloaded package.
 *
 * Ordered so that every cheap refusal happens before anything is written: hash
 * first, then parse, then apply, then validate, and only then touch the files
 * that matter.
 */
export async function installPackage(input: InstallInput): Promise<InstallOutcome> {
  const { paths, packageBytes, expectedSha256, kind } = input;

  // 1. The package must be exactly what the signed manifest described.
  const actual = sha256(packageBytes);
  if (actual !== expectedSha256.toLowerCase()) {
    return { ok: false, reason: 'the downloaded update was damaged in transit', ...NOTHING };
  }

  // 2. Parse.
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(packageBytes).toString('utf8'));
  } catch {
    return { ok: false, reason: 'the update could not be read', ...NOTHING };
  }

  // 3. Build the next catalog in memory. Nothing on disk has changed yet.
  let next: Catalog;
  let counts = { ...NOTHING };

  if (kind === 'full') {
    const check = validateCatalog(payload);
    if (!check.ok) {
      return { ok: false, reason: `the update failed validation: ${check.problems[0]}`, ...NOTHING };
    }
    const installed = await readCatalog(paths.current);
    next = payload as Catalog;
    counts = {
      added: next.products.length,
      updated: 0,
      deprecated: next.products.filter((p) => p.deprecated).length,
      removed: installed ? installed.products.length : 0,
    };
  } else {
    const installed = await readCatalog(paths.current);
    if (!installed) {
      return {
        ok: false,
        reason: 'there is no installed catalog for this incremental update to apply to',
        ...NOTHING,
      };
    }
    const result = applyDelta(installed, payload as CatalogDelta);
    if (!result.ok || !result.catalog) {
      return { ok: false, reason: result.reason ?? 'the update could not be applied', ...NOTHING };
    }
    next = result.catalog;
    counts = {
      added: result.added,
      updated: result.updated,
      deprecated: result.deprecated,
      removed: result.removed,
    };
  }

  // 4. Validate the result, not just the input. A delta can apply cleanly and
  //    still produce a catalog that is internally wrong.
  const check = validateCatalog(next);
  if (!check.ok) {
    return {
      ok: false,
      reason: `the updated catalog failed validation: ${check.problems[0]}`,
      ...NOTHING,
    };
  }

  // 5. Stage it, under a name unique to this attempt.
  //
  //    A fixed `incoming.json` is shared state: two windows installing at once
  //    overwrite each other's staged file, and whichever renames second finds
  //    nothing there. Each attempt gets its own.
  const staging = `${paths.incoming}.${process.pid}.${randomUUID()}`;
  try {
    await atomicWrite(staging, JSON.stringify(next));
  } catch (err) {
    return { ok: false, reason: `the update could not be written: ${String(err)}`, ...NOTHING };
  }

  // 6. Read the staged file back before trusting it — this is what catches a
  //    full disk, which otherwise shows up as a truncated catalog next launch.
  const staged = await readCatalog(staging);
  if (!staged || staged.meta.version !== next.meta.version) {
    await rm(staging, { force: true });
    return { ok: false, reason: 'the staged update could not be read back', ...NOTHING };
  }

  // 7. Swap, holding a lock so two installs cannot interleave their renames.
  const release = await acquireLock(paths);
  if (!release) {
    await rm(staging, { force: true });
    return { ok: false, reason: 'another update is already being installed', ...NOTHING };
  }
  try {
    if (existsSync(paths.current)) await rename(paths.current, paths.previous);
    await rename(staging, paths.current);
  } catch (err) {
    const restored = await rollback(paths);
    await rm(staging, { force: true });
    return {
      ok: false,
      reason: `the update could not be installed: ${String(err)}`,
      rolledBack: restored,
      ...NOTHING,
    };
  } finally {
    await release();
  }

  // 8. Confirm what is now live actually opens.
  const live = await readCatalog(paths.current);
  if (!live) {
    const restored = await rollback(paths);
    return {
      ok: false,
      reason: 'the installed catalog did not open, so the previous one was restored',
      rolledBack: restored,
      ...NOTHING,
    };
  }

  await rm(staging, { force: true });
  return { ok: true, version: live.meta.version, ...counts };
}

/**
 * Puts the previous catalog back.
 *
 * Only replaces the live file once the saved copy has been read and found
 * valid — restoring a broken backup over a broken catalog helps nobody.
 */
export async function rollback(paths: CatalogPaths): Promise<boolean> {
  if (!existsSync(paths.previous)) return false;
  const saved = await readCatalog(paths.previous);
  if (!saved) return false;
  try {
    await rename(paths.previous, paths.current);
    return (await readCatalog(paths.current)) !== null;
  } catch {
    return false;
  }
}

export interface RepairReport {
  ok: boolean;
  action: 'none' | 'restored' | 'cleared';
  removedTemporaryFiles: number;
  version?: string;
}

/**
 * Repairs local catalog storage.
 *
 * Clears staged and temporary files, then makes sure something valid is live —
 * restoring the previous copy if the current one will not open. Public data
 * only; the private inventory is in another directory and is never in scope.
 */
export async function repair(paths: CatalogPaths): Promise<RepairReport> {
  let removed = 0;
  if (existsSync(paths.incoming)) {
    await rm(paths.incoming, { force: true });
    removed++;
  }

  const live = await readCatalog(paths.current);
  if (live) return { ok: true, action: 'none', removedTemporaryFiles: removed, version: live.meta.version };

  if (await rollback(paths)) {
    const restored = await readCatalog(paths.current);
    return {
      ok: true,
      action: 'restored',
      removedTemporaryFiles: removed,
      version: restored?.meta.version,
    };
  }

  // Nothing usable. Clear the slate so the next check performs a clean full
  // download rather than trying to patch wreckage.
  await rm(paths.current, { force: true });
  await rm(paths.previous, { force: true });
  return { ok: false, action: 'cleared', removedTemporaryFiles: removed };
}
