/**
 * Updating the application itself.
 *
 * Separate from the catalog updater, and for a different reason: the catalog is
 * data the application reads, while this replaces the application. They share
 * the signing scheme and the resumable downloader, and nothing else.
 *
 * **Why this is hand-rolled rather than electron-updater.** On macOS the
 * standard updater hands the download to Squirrel.Mac, which refuses anything
 * not signed with an Apple *Developer ID* — a certificate that costs money
 * every year. This build is ad-hoc signed, so that path cannot work.
 *
 * The trust it would have provided is replaced with the Ed25519 signature the
 * catalog already uses: a release manifest is signed with a key whose public
 * half is compiled in, and the manifest carries the package hash. An update
 * that is not signed by us, or whose bytes do not match, is refused before
 * anything is unpacked. That is the same guarantee, sourced from a key we hold
 * rather than one Apple sells.
 *
 * The trade-off, stated plainly: Gatekeeper still does not vouch for this
 * application to a stranger. Replacing an already-installed copy in place works
 * because the replacement inherits no quarantine flag — but a *first* install
 * on someone else's Mac still needs the right-click-Open dance. Only a
 * Developer ID fixes that, and only by paying for one.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadPackage, fetchJson } from '../catalog/download.js';
import { canonicalise, sha256 } from '../catalog/manifest.js';
import { CATALOG_PUBLIC_KEYS } from '../catalog/keys.js';
import { compareVersions } from '../catalog/model.js';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Where application releases are published. */
export const APP_MANIFEST_URL =
  'https://github.com/kxd21/groundplan-catalog/releases/latest/download/app-manifest.json';

export interface AppPackage {
  url: string;
  bytes: number;
  sha256: string;
}

export interface AppManifest {
  schema: 1;
  version: string;
  released: string;
  notes?: string;
  /** Keyed `${process.platform}-${process.arch}`, e.g. `darwin-arm64`. */
  packages: Record<string, AppPackage>;
  signature?: string;
}

export interface AppUpdatePlan {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  package?: AppPackage;
  notes?: string;
  reason?: string;
}

/** Verifies a manifest against the keys compiled into this build. */
/**
 * True when a manifest carries a signature from a key we pinned.
 *
 * Exported because it is the whole trust boundary, and a second source of
 * updates — a folder on a USB stick — must clear exactly the same bar as the
 * network one rather than a lower one.
 */
export function verifyManifest(manifest: AppManifest): boolean {
  if (!manifest.signature) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, 'base64');
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  const data = Buffer.from(canonicalise(manifest), 'utf8');
  for (const encoded of CATALOG_PUBLIC_KEYS) {
    try {
      const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
      if (cryptoVerify(null, data, key, signature)) return true;
    } catch {
      // A malformed pinned key must not abandon the whole check.
    }
  }
  return false;
}

export interface CheckInput {
  currentVersion: string;
  platform: string;
  arch: string;
  signal?: AbortSignal;
  url?: string;
}

/**
 * Looks for a newer application build.
 *
 * Offline is an ordinary answer, not a failure — the caller says "could not
 * check" and carries on.
 */
export async function checkForAppUpdate(input: CheckInput): Promise<AppUpdatePlan> {
  const base: AppUpdatePlan = { available: false, currentVersion: input.currentVersion };

  const manifest = await fetchJson<AppManifest>(input.url ?? APP_MANIFEST_URL, input.signal);
  if (!manifest) return { ...base, reason: 'could not reach the update server' };

  // Signature first: nothing else in the manifest means anything until it holds.
  if (!verifyManifest(manifest)) return { ...base, reason: 'the update manifest is not correctly signed' };

  if (compareVersions(manifest.version, input.currentVersion) <= 0) {
    return { ...base, latestVersion: manifest.version, reason: 'the application is up to date' };
  }

  const key = `${input.platform}-${input.arch}`;
  const pkg = manifest.packages?.[key];
  if (!pkg) {
    return {
      ...base,
      latestVersion: manifest.version,
      reason: `release ${manifest.version} has no build for ${key}`,
    };
  }

  return {
    available: true,
    currentVersion: input.currentVersion,
    latestVersion: manifest.version,
    package: pkg,
    notes: manifest.notes,
  };
}

export interface StagedUpdate {
  ok: boolean;
  reason?: string;
  /** Verified archive, ready to install. */
  archivePath?: string;
  version?: string;
}

/**
 * Downloads and verifies a release, without installing it.
 *
 * Kept separate from installing so nothing touches the installed application
 * until the bytes have been proven to be the ones we signed.
 */
export async function stageAppUpdate(
  plan: AppUpdatePlan,
  directory: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<StagedUpdate> {
  if (!plan.available || !plan.package || !plan.latestVersion) {
    return { ok: false, reason: 'there is no update to install' };
  }

  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, `Groundplan-${plan.latestVersion}${archiveSuffix()}`);

  const download = await downloadPackage({
    url: plan.package.url,
    target: archivePath,
    expectedBytes: plan.package.bytes,
    signal,
    onProgress: ({ received, total }) => onProgress?.(received, total),
  });
  if (!download.ok || !download.bytes) {
    return { ok: false, reason: download.reason ?? 'the download did not finish' };
  }

  if (sha256(download.bytes) !== plan.package.sha256.toLowerCase()) {
    // A package that fails its hash will never pass on a retry; drop it so the
    // resumable download does not keep handing back the same bad bytes.
    await rm(archivePath, { force: true });
    return { ok: false, reason: 'the downloaded update was damaged in transit' };
  }

  return { ok: true, archivePath, version: plan.latestVersion };
}

function archiveSuffix(): string {
  return process.platform === 'darwin' ? '.zip' : '.exe';
}

/**
 * Installs a staged update and restarts.
 *
 * On macOS the running application cannot overwrite itself, so the swap is done
 * by a small script that waits for this process to exit first. The outgoing
 * bundle is kept until the replacement has been moved into place, so a failure
 * half way leaves a working application rather than none.
 *
 * On Windows the NSIS installer is simply run; it handles the replacement.
 */
export async function installAppUpdate(
  staged: StagedUpdate,
  appPath: string,
  quit: () => void,
): Promise<{ ok: boolean; reason?: string }> {
  if (!staged.ok || !staged.archivePath || !existsSync(staged.archivePath)) {
    return { ok: false, reason: 'there is no verified update to install' };
  }

  if (process.platform === 'win32') {
    // NSIS: /S is silent, and the installer closes the running copy, replaces
    // it in place and relaunches. Nothing here needs to touch the files, which
    // is why Windows needs no equivalent of the macOS swap script.
    try {
      spawn(staged.archivePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      return { ok: false, reason: `the installer would not start: ${String(err)}` };
    }
    quit();
    return { ok: true };
  }

  if (process.platform !== 'darwin') {
    return { ok: false, reason: `automatic installation is not supported on ${process.platform}` };
  }

  const workDir = join(staged.archivePath, '..', `staging-${staged.version}`);
  const scriptPath = join(staged.archivePath, '..', `install-${staged.version}.sh`);

  // Quoted throughout: application paths routinely contain spaces, and an
  // unquoted path here would delete the wrong thing.
  const script = `#!/bin/bash
set -e
APP=${JSON.stringify(appPath)}
ARCHIVE=${JSON.stringify(staged.archivePath)}
WORK=${JSON.stringify(workDir)}
PID=${process.pid}

# Wait for the running application to exit before touching its bundle.
for i in $(seq 1 100); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done

rm -rf "$WORK"
mkdir -p "$WORK"
# ditto preserves the bundle's symlinks and extended attributes; unzip does not.
/usr/bin/ditto -xk "$ARCHIVE" "$WORK"

NEW="$(/usr/bin/find "$WORK" -maxdepth 2 -name '*.app' -print -quit)"
if [ -z "$NEW" ] || [ ! -d "$NEW" ]; then
  exit 1
fi

# Keep the outgoing copy until the replacement is in place.
rm -rf "$APP.old"
mv "$APP" "$APP.old"
if mv "$NEW" "$APP"; then
  rm -rf "$APP.old"
else
  # Put the working copy back rather than leaving nothing installed.
  mv "$APP.old" "$APP"
  exit 1
fi

# A bundle assembled locally carries no quarantine flag, but strip it anyway in
# case the archive was fetched by something that set one.
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

rm -rf "$WORK" "$ARCHIVE"
/usr/bin/open "$APP"
rm -f "$0"
`;

  try {
    await writeFile(scriptPath, script, { mode: 0o700 });
  } catch (err) {
    return { ok: false, reason: `the installer script could not be written: ${String(err)}` };
  }

  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
  quit();
  return { ok: true };
}

/** Removes staged downloads left behind by an interrupted update. */
export async function cleanStaging(directory: string): Promise<void> {
  try {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(directory)) {
      if (/^(staging-|install-)/.test(name)) await rm(join(directory, name), { recursive: true, force: true });
    }
  } catch {
    // Nothing staged, or the directory does not exist yet.
  }
}

/** Reads a manifest from disk, for testing a release before publishing it. */
export async function readManifest(path: string): Promise<AppManifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AppManifest;
  } catch {
    return null;
  }
}
