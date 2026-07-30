/**
 * Path identity for capability checks and deduplication.
 *
 * `resolve` alone is not enough on the filesystems Groundplan targets: NTFS and
 * default APFS are case-insensitive, and macOS callers often disagree about
 * Unicode composition. Comparing raw strings then treats one file as two.
 */

import { resolve } from 'node:path';

/** Absolute path suitable for filesystem I/O (casing preserved). */
export function canonicalPath(path: string): string {
  return resolve(path);
}

/**
 * Equality key for the same file on case-insensitive volumes.
 *
 * Windows always folds; macOS folds because the default APFS volume is
 * case-insensitive. Linux (and rare case-sensitive APFS) keeps exact case.
 */
export function pathIdentity(path: string): string {
  const resolved = resolve(path).normalize('NFC');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return resolved.toLowerCase();
  }
  return resolved;
}

export function samePath(a: string, b: string): boolean {
  return pathIdentity(a) === pathIdentity(b);
}
