/**
 * The catalog update service.
 *
 * Decides *when* to look, and what to do about what it finds. The pieces it
 * drives — manifest verification, download, install, rollback — each refuse
 * independently; this only sequences them and remembers the user's preferences.
 *
 * Two rules shape the behaviour:
 *
 * Never interrupt the work. A plan being drawn matters more than a catalog
 * being current, so checks are quiet, failures are silent unless asked about,
 * and an out-of-date catalog is a note rather than a blocker.
 *
 * Never poll. A check on launch and a long interval after that is enough for
 * data that changes a few times a month. Anything more is traffic nobody asked
 * for.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { downloadPackage, fetchJson } from './download.js';
import { installPackage, loadInstalled, repair, type CatalogPaths } from './install.js';
import { planUpdate, type CatalogManifest, type UpdatePlan } from './manifest.js';
import { CATALOG_MANIFEST_URL, CATALOG_PUBLIC_KEYS } from './keys.js';

export type UpdatePolicy =
  /** Download and install anything, without asking. */
  | 'automatic'
  /** Install small updates quietly; ask before large ones. */
  | 'automatic-small'
  /** Always ask first. */
  | 'notify'
  /** Only when the user asks. */
  | 'manual';

export interface CatalogPreferences {
  policy: UpdatePolicy;
  /** Bytes above which 'automatic-small' asks instead of installing. */
  smallUpdateLimit: number;
  /** Hours between checks while the application stays open. */
  checkIntervalHours: number;
  /** A version the user asked not to be reminded about again for now. */
  snoozedVersion?: string;
  lastCheck?: string;
  lastCheckSucceeded?: boolean;
}

export const DEFAULT_PREFERENCES: CatalogPreferences = {
  // Notify rather than auto-install by default: the first time an application
  // changes data under someone, they should have said yes to it.
  policy: 'notify',
  smallUpdateLimit: 5 * 1024 * 1024,
  checkIntervalHours: 12,
};

export interface CatalogStatus {
  installedVersion: string;
  productCount: number;
  lastCheck?: string;
  lastCheckSucceeded?: boolean;
  /** Set when a release is available and not snoozed. */
  available?: {
    version: string;
    bytes: number;
    kind: 'delta' | 'full';
    counts: CatalogManifest['counts'];
    urgent: boolean;
    notes?: string;
  };
  /** Set when a release exists but cannot be installed by this build. */
  blocked?: string;
  offline?: boolean;
}

export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'installing' | 'done' | 'failed';
  received?: number;
  total?: number;
  message?: string;
}

function preferencesPath(root: string): string {
  return join(root, 'update-preferences.json');
}

export async function loadPreferences(root: string): Promise<CatalogPreferences> {
  try {
    const parsed = JSON.parse(await readFile(preferencesPath(root), 'utf8')) as Partial<CatalogPreferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(root: string, preferences: CatalogPreferences): Promise<void> {
  await mkdir(dirname(preferencesPath(root)), { recursive: true });
  await writeFile(preferencesPath(root), JSON.stringify(preferences, null, 2), 'utf8');
}

/** Whether enough time has passed to look again. */
export function shouldCheck(preferences: CatalogPreferences, now = Date.now()): boolean {
  if (preferences.policy === 'manual') return false;
  if (!preferences.lastCheck) return true;
  const elapsed = now - Date.parse(preferences.lastCheck);
  return !Number.isFinite(elapsed) || elapsed >= preferences.checkIntervalHours * 3600_000;
}

/** Whether a plan should install without asking, under the current policy. */
export function shouldInstallSilently(plan: UpdatePlan, preferences: CatalogPreferences): boolean {
  if (plan.kind === 'none' || plan.blocked) return false;
  // An urgent correction is still offered rather than forced, but it is never
  // silently deferred either — the user is told immediately.
  if (plan.urgent) return preferences.policy === 'automatic';
  if (preferences.policy === 'automatic') return true;
  if (preferences.policy === 'automatic-small') {
    return (plan.package?.bytes ?? Infinity) <= preferences.smallUpdateLimit;
  }
  return false;
}

export interface CheckResult {
  status: CatalogStatus;
  plan?: UpdatePlan;
  manifest?: CatalogManifest;
}

/**
 * Looks for a newer catalog.
 *
 * Being offline is an ordinary outcome, not an error: the status says the check
 * could not run and the application carries on with what it already has.
 */
export async function checkForUpdate(
  paths: CatalogPaths,
  appVersion: string,
  preferences: CatalogPreferences,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const installed = await loadInstalled(paths);
  const status: CatalogStatus = {
    installedVersion: installed.meta.version,
    productCount: installed.products.length,
    lastCheck: preferences.lastCheck,
    lastCheckSucceeded: preferences.lastCheckSucceeded,
  };

  const manifest = await fetchJson<CatalogManifest>(CATALOG_MANIFEST_URL, signal);
  if (!manifest) return { status: { ...status, offline: true } };

  const plan = planUpdate({
    manifest,
    installedVersion: installed.meta.version,
    appVersion,
    publicKeys: CATALOG_PUBLIC_KEYS,
    localBroken: installed.meta.version === '0.0.0',
  });

  status.lastCheck = new Date().toISOString();
  status.lastCheckSucceeded = true;

  if (plan.blocked) return { status: { ...status, blocked: plan.reason }, plan, manifest };
  if (plan.kind === 'none') return { status, plan, manifest };

  // A snoozed version stays hidden until something newer appears.
  if (preferences.snoozedVersion === plan.toVersion && !plan.urgent) {
    return { status, plan, manifest };
  }

  return {
    status: {
      ...status,
      available: {
        version: plan.toVersion,
        bytes: plan.package?.bytes ?? 0,
        kind: plan.kind,
        counts: manifest.counts,
        urgent: Boolean(plan.urgent),
        notes: manifest.notes,
      },
    },
    plan,
    manifest,
  };
}

export interface ApplyResult {
  ok: boolean;
  version?: string;
  reason?: string;
  added: number;
  updated: number;
  deprecated: number;
}

/**
 * Downloads and installs a planned update.
 *
 * The partial download is kept on failure so a retry resumes. Nothing touches
 * the live catalog until the bytes have been verified against the signed
 * manifest, so an interruption at any point leaves the installed catalog as it
 * was.
 */
export async function applyUpdate(
  paths: CatalogPaths,
  plan: UpdatePlan,
  onProgress?: (progress: UpdateProgress) => void,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const nothing = { added: 0, updated: 0, deprecated: 0 };
  if (!plan.package || plan.kind === 'none') {
    return { ok: false, reason: 'there is nothing to install', ...nothing };
  }

  const partial = join(paths.root, `download-${plan.toVersion}.part`);

  onProgress?.({ phase: 'downloading', received: 0, total: plan.package.bytes });
  const download = await downloadPackage({
    url: plan.package.url,
    target: partial,
    expectedBytes: plan.package.bytes,
    signal,
    onProgress: ({ received, total }) => onProgress?.({ phase: 'downloading', received, total }),
  });

  if (!download.ok || !download.bytes) {
    onProgress?.({ phase: 'failed', message: download.reason });
    return { ok: false, reason: download.reason ?? 'the download did not finish', ...nothing };
  }

  onProgress?.({ phase: 'installing' });
  const installed = await installPackage({
    paths,
    packageBytes: download.bytes,
    expectedSha256: plan.package.sha256,
    kind: plan.kind,
  });

  if (!installed.ok) {
    onProgress?.({ phase: 'failed', message: installed.reason });
    // A package that failed verification is not worth resuming; a fresh copy
    // is the only thing that can succeed next time.
    await import('node:fs/promises').then((fs) => fs.rm(partial, { force: true }));
    return { ok: false, reason: installed.reason, ...nothing };
  }

  await import('node:fs/promises').then((fs) => fs.rm(partial, { force: true }));
  onProgress?.({ phase: 'done' });

  return {
    ok: true,
    version: installed.version,
    added: installed.added,
    updated: installed.updated,
    deprecated: installed.deprecated,
  };
}

/** Validates local storage and recovers what it can. Public data only. */
export async function repairCatalog(paths: CatalogPaths): Promise<ReturnType<typeof repair>> {
  return repair(paths);
}
