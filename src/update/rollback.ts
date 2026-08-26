/**
 * Going back to the version that worked.
 *
 * An update that turns out to be bad is worse than no update at all, because
 * the person it broke is mid-show and did not choose the timing. Until now the
 * only way back was to find an old installer and run it by hand, and on macOS
 * the outgoing bundle was deleted the moment the new one was in place.
 *
 * This does not keep a copy of the old application. It does not need to: every
 * release publishes its own signed `app-manifest.json` alongside its packages,
 * so the release the user came from is still described, still signed, and still
 * downloadable. Reverting is therefore the ordinary update pipeline — fetch a
 * manifest, check the signature, check the hash, swap — pointed at an older
 * release instead of the newest one. Same guarantees, no new install mechanics,
 * and nothing on disk to go stale or fill a drive.
 *
 * What IS kept is one small note saying which version this copy replaced, so
 * the app can offer the way back by name rather than asking the user to
 * remember what they were on.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fetchJson } from '../catalog/download.js';
import { compareVersions } from '../catalog/model.js';
import type { AppManifest, AppUpdatePlan } from './app-update.js';
import { verifyManifest } from './app-update.js';

/** Where a release's own manifest lives, by version. */
export const releaseManifestUrl = (version: string): string =>
  `https://github.com/kxd21/groundplan-catalog/releases/download/app-v${version}/app-manifest.json`;

export interface RollbackRecord {
  /** The version this copy replaced — the one to go back to. */
  from: string;
  /** The version that replaced it. */
  to: string;
  /** When the swap happened, ISO. */
  at: string;
}

const FILE = 'rollback.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A version string we are willing to put in a URL. */
function safeVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d+(\.\d+){0,3}$/.test(value) ? value : null;
}

export function parseRollback(value: unknown): RollbackRecord | null {
  if (!isRecord(value)) return null;
  const from = safeVersion(value.from);
  const to = safeVersion(value.to);
  if (!from || !to) return null;
  const at = typeof value.at === 'string' ? value.at : new Date(0).toISOString();
  // Going "back" to something newer is not a rollback; a record like that is
  // corrupt or hand-edited, and acting on it would be an unrequested upgrade.
  if (compareVersions(from, to) >= 0) return null;
  return { from, to, at };
}

export async function loadRollback(userData: string): Promise<RollbackRecord | null> {
  try {
    return parseRollback(JSON.parse(await readFile(join(userData, FILE), 'utf8')));
  } catch {
    return null;
  }
}

export async function saveRollback(userData: string, record: RollbackRecord): Promise<void> {
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function clearRollback(userData: string): Promise<void> {
  await rm(join(userData, FILE), { force: true });
}

/**
 * True when this copy can be reverted right now.
 *
 * The record is only good while the running version is the one it says replaced
 * something. After a second update the note describes a hop that is no longer
 * the last one, and after a manual reinstall it may describe nothing real —
 * either way, offering it would take the user somewhere they did not expect.
 */
export function canRevert(record: RollbackRecord | null, currentVersion: string): boolean {
  return !!record && record.to === currentVersion;
}

export interface RevertInput {
  currentVersion: string;
  platform: string;
  arch: string;
  /** Overridable for tests. */
  url?: string;
  signal?: AbortSignal;
}

/**
 * Builds an install plan for an older release.
 *
 * Deliberately does NOT reuse `checkForAppUpdate`: that one refuses anything
 * not newer than the running copy, which is exactly what this is. Everything
 * else it does — signature first, then the platform package — is repeated here
 * rather than relaxed there, so no code path that looks for an *update* can be
 * talked into installing something older.
 */
export async function planRevert(version: string, input: RevertInput): Promise<AppUpdatePlan> {
  const base: AppUpdatePlan = { available: false, currentVersion: input.currentVersion };

  const safe = safeVersion(version);
  if (!safe) return { ...base, reason: `“${version}” is not a version number` };

  const manifest = await fetchJson<AppManifest>(input.url ?? releaseManifestUrl(safe), input.signal);
  if (!manifest) return { ...base, reason: `release ${safe} could not be reached` };

  // Signature first: nothing else in the manifest means anything until it holds.
  if (!verifyManifest(manifest)) {
    return { ...base, reason: `the manifest for ${safe} is not correctly signed` };
  }

  // The manifest has to be the release we asked for. Without this a redirect or
  // a mis-uploaded asset could hand back a different version — including a
  // newer one — and this would install it under the name of a rollback.
  if (manifest.version !== safe) {
    return { ...base, reason: `release ${safe} reports itself as ${manifest.version}` };
  }

  if (compareVersions(manifest.version, input.currentVersion) >= 0) {
    return { ...base, latestVersion: manifest.version, reason: `${safe} is not older than what you are running` };
  }

  const key = `${input.platform}-${input.arch}`;
  const pkg = manifest.packages?.[key];
  if (!pkg) return { ...base, latestVersion: manifest.version, reason: `release ${safe} has no build for ${key}` };

  return {
    available: true,
    currentVersion: input.currentVersion,
    latestVersion: manifest.version,
    package: pkg,
    notes: manifest.notes,
  };
}
