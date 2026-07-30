/**
 * Updating from a USB stick.
 *
 * There is no update server, and for this application there may never need to
 * be one. The machines that run it live in hotel back-of-house and convention
 * centre offices — places with no internet, or with a guest network nobody will
 * put a work laptop on. A release that travels on a stick, hand to hand, is not
 * a fallback for those people; it is the normal way software arrives.
 *
 * **The trust is identical to the network path, on purpose.** A USB update is
 * checked exactly the way a downloaded one is: the manifest must carry an
 * Ed25519 signature from a key compiled into this build, and the archive must
 * match the SHA-256 the signed manifest names. A stick found in a car park is
 * therefore no more dangerous than a hostile web server — both are refused by
 * the same two checks. What changes is the transport, and nothing else.
 *
 * The folder is the one `tools/usb-release.ts` writes:
 *
 *   GROUNDPLAN/
 *     app-manifest.json          signed
 *     Groundplan-1.1.0-mac-arm64.zip
 *     Groundplan-Setup-1.1.0-win-x64.exe
 *     README.txt
 */

import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

import { compareVersions } from '../catalog/model.js';
import {
  verifyManifest,
  type AppManifest,
  type AppUpdatePlan,
  type StagedUpdate,
} from './app-update.js';

/** The file a release folder is recognised by. */
export const USB_MANIFEST_NAME = 'app-manifest.json';

export interface UsbSource {
  /** Folder holding the manifest and the archives. */
  folder: string;
  manifest: AppManifest;
}

export interface UsbCheckInput {
  currentVersion: string;
  platform: string;
  arch: string;
}

/**
 * Reads and verifies a release folder.
 *
 * Returns a reason rather than throwing for every ordinary way this goes wrong
 * — wrong folder, no manifest, a stick that was ejected mid-read — because all
 * of those are things to tell the user, not faults.
 */
export async function readUsbSource(folder: string): Promise<{ source?: UsbSource; reason?: string }> {
  const path = join(folder, USB_MANIFEST_NAME);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { reason: `No ${USB_MANIFEST_NAME} in that folder. Choose the folder the release was copied into.` };
  }

  let manifest: AppManifest;
  try {
    manifest = JSON.parse(raw) as AppManifest;
  } catch {
    return { reason: 'The update manifest on that drive is damaged.' };
  }

  // Signature first. Nothing else the manifest claims means anything until it
  // holds — including which files to trust and what they should hash to.
  if (!verifyManifest(manifest)) {
    return {
      reason:
        'That update is not signed by Groundplan. It has been refused. ' +
        'Only use a stick prepared from a Groundplan release.',
    };
  }

  return { source: { folder: resolve(folder), manifest } };
}

/**
 * Works out whether a verified folder holds something newer for this machine.
 *
 * `url` in the signed manifest is a download address, which a stick has no use
 * for; the file beside the manifest is located by name instead. The hash still
 * comes from the manifest, so substituting a different file for the right name
 * fails at the next step.
 */
export function planUsbUpdate(source: UsbSource, input: UsbCheckInput): AppUpdatePlan {
  const base: AppUpdatePlan = { available: false, currentVersion: input.currentVersion };
  const { manifest } = source;

  if (compareVersions(manifest.version, input.currentVersion) <= 0) {
    return {
      ...base,
      latestVersion: manifest.version,
      reason:
        compareVersions(manifest.version, input.currentVersion) === 0
          ? `That drive holds ${manifest.version}, which is what you are running.`
          : `That drive holds ${manifest.version}, which is older than the ${input.currentVersion} you are running.`,
    };
  }

  const key = `${input.platform}-${input.arch}`;
  const pkg = manifest.packages?.[key];
  if (!pkg) {
    return {
      ...base,
      latestVersion: manifest.version,
      reason: `That drive has ${manifest.version}, but no build for this computer (${key}).`,
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', fail);
    stream.on('end', () => done());
  });
  return hash.digest('hex');
}

/**
 * Copies the archive off the stick and proves it is the one that was signed.
 *
 * Copied rather than installed in place: a USB stick can be pulled at any
 * moment, and an installer reading from one that vanishes half way through is
 * exactly the failure this is meant to avoid. The hash is checked after the
 * copy, so a read error on the stick is caught here rather than by the
 * installer.
 */
export async function stageUsbUpdate(
  source: UsbSource,
  plan: AppUpdatePlan,
  directory: string,
): Promise<StagedUpdate> {
  if (!plan.available || !plan.package || !plan.latestVersion) {
    return { ok: false, reason: 'there is no update to install' };
  }

  // The manifest's url is an address; on a stick the file sits beside it.
  const name = basename(new URL(plan.package.url, 'file:///').pathname);
  if (!name || name.includes('..')) return { ok: false, reason: 'the manifest names an invalid package' };

  const from = join(source.folder, name);
  try {
    const info = await stat(from);
    if (!info.isFile()) return { ok: false, reason: `${name} on that drive is not a file` };
    if (info.size !== plan.package.bytes) {
      return {
        ok: false,
        reason: `${name} on that drive is the wrong size. The copy is incomplete or damaged.`,
      };
    }
  } catch {
    return { ok: false, reason: `${name} is missing from that drive.` };
  }

  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, name);

  try {
    await copyFile(from, archivePath);
  } catch (error) {
    return {
      ok: false,
      reason: `The update could not be copied off the drive: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const digest = await hashFile(archivePath);
  if (digest !== plan.package.sha256.toLowerCase()) {
    // Never leave a package that failed its hash lying in the staging folder.
    await rm(archivePath, { force: true });
    return { ok: false, reason: 'The update on that drive does not match its signature and was refused.' };
  }

  return { ok: true, archivePath, version: plan.latestVersion };
}

/**
 * Looks for a release folder on a drive.
 *
 * Checks the drive root and one level down, which covers both "copied the
 * folder onto the stick" and "copied the contents of the folder onto the
 * stick" — the two things people actually do.
 */
export async function findReleaseFolder(root: string): Promise<string | null> {
  try {
    const direct = join(root, USB_MANIFEST_NAME);
    await stat(direct);
    return root;
  } catch {
    // Not at the root; look one level in.
  }

  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        await stat(join(root, entry.name, USB_MANIFEST_NAME));
        return join(root, entry.name);
      } catch {
        // Not this one.
      }
    }
  } catch {
    // Unreadable drive.
  }

  return null;
}
