/**
 * Release manifests, and the trust decisions made from them.
 *
 * The manifest is the only thing fetched before anything is trusted, so it is
 * kept small and it is signed. It carries the SHA-256 of each package, which
 * means one signature transitively covers the payloads too — the packages
 * themselves need no separate signature, and a tampered package fails its hash
 * check against a manifest that could not have been forged.
 *
 * Ed25519 via Node's own `crypto`: no dependency, no parameter choices to get
 * wrong, and 44-byte public keys that are comfortable to pin in a binary.
 */

import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

import { compareVersions, SUPPORTED_CATALOG_SCHEMAS } from './model.js';

export interface PackageRef {
  url: string;
  bytes: number;
  sha256: string;
}

export interface CatalogManifest {
  /** Shape of the manifest itself. */
  schema: 1;
  catalogVersion: string;
  catalogSchemaVersion: number;
  released: string;
  /** Oldest application build that may install this release. */
  minAppVersion: string;
  /** Flags a correction people should not sit on — bad power figures and such. */
  urgent?: boolean;
  channel?: 'stable' | 'beta';
  counts: { added: number; updated: number; deprecated: number; assets?: number };
  notes?: string;

  full: PackageRef;
  /**
   * Patches keyed by the version they apply *from*.
   *
   * A map rather than a chain: the client takes one hop or falls back to a full
   * download. Chaining patches multiplies the ways an update can half-apply for
   * a saving that does not matter at these sizes.
   */
  deltas?: Record<string, PackageRef>;

  /** Base64 Ed25519 over the canonical form of every field above. */
  signature?: string;
}

/**
 * Canonical bytes of a manifest, for signing and verifying.
 *
 * Keys are sorted at every level so that two structurally identical manifests
 * always produce identical bytes — otherwise a signature would depend on
 * whatever order a JSON serializer happened to use.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, v]) => key !== 'signature' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Signs a manifest. Used by the publisher, never by the app. */
export function signManifest(manifest: CatalogManifest, privateKeyPem: string): CatalogManifest {
  const signature = cryptoSign(null, Buffer.from(canonicalise(manifest), 'utf8'), privateKeyPem);
  return { ...manifest, signature: signature.toString('base64') };
}

/**
 * Verifies a manifest against the keys built into this application.
 *
 * More than one key is accepted so a signing key can be rotated without
 * stranding installs that only know the old one.
 */
export function verifyManifest(manifest: CatalogManifest, publicKeysSpkiBase64: string[]): boolean {
  if (!manifest.signature) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, 'base64');
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  const data = Buffer.from(canonicalise(manifest), 'utf8');
  for (const encoded of publicKeysSpkiBase64) {
    try {
      const key = createPublicKey({
        key: Buffer.from(encoded, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (cryptoVerify(null, data, key, signature)) return true;
    } catch {
      // A malformed pinned key must not throw the whole check away; try the next.
    }
  }
  return false;
}

export type UpdateKind = 'none' | 'delta' | 'full';

export interface UpdatePlan {
  kind: UpdateKind;
  /** Populated for 'delta' and 'full'. */
  package?: PackageRef;
  fromVersion: string;
  toVersion: string;
  /** Set when there is nothing to do, or the release must be refused. */
  reason?: string;
  /** True when the release cannot be installed by this build at all. */
  blocked?: boolean;
  urgent?: boolean;
}

export interface PlanInput {
  manifest: CatalogManifest;
  installedVersion: string;
  appVersion: string;
  publicKeys: string[];
  /** Forces a full download — the user's "reinstall the catalog" action. */
  forceFull?: boolean;
  /** True when the local catalog is missing or failed validation. */
  localBroken?: boolean;
}

/**
 * Decides what, if anything, to do about a published release.
 *
 * Every refusal is a named reason rather than a silent no, because the two
 * cases a user must be able to tell apart — "you are up to date" and "this
 * release needs a newer application" — look identical otherwise.
 */
export function planUpdate(input: PlanInput): UpdatePlan {
  const { manifest, installedVersion, appVersion, publicKeys } = input;
  const base: UpdatePlan = {
    kind: 'none',
    fromVersion: installedVersion,
    toVersion: manifest.catalogVersion,
    urgent: manifest.urgent,
  };

  // Signature first: nothing else in the manifest can be believed until it
  // holds, including the version numbers the rest of this function reads.
  if (!verifyManifest(manifest, publicKeys)) {
    return { ...base, blocked: true, reason: 'the update manifest is not correctly signed' };
  }

  if (!SUPPORTED_CATALOG_SCHEMAS.includes(manifest.catalogSchemaVersion)) {
    return {
      ...base,
      blocked: true,
      reason: `catalog ${manifest.catalogVersion} needs a newer version of Groundplan`,
    };
  }

  if (compareVersions(appVersion, manifest.minAppVersion) < 0) {
    return {
      ...base,
      blocked: true,
      reason: `catalog ${manifest.catalogVersion} requires Groundplan ${manifest.minAppVersion} or newer`,
    };
  }

  const order = compareVersions(manifest.catalogVersion, installedVersion);

  // Refusing to go backwards closes the downgrade attack: replaying an old but
  // genuinely signed manifest to reintroduce a corrected specification.
  if (order < 0) {
    return { ...base, reason: 'the published catalog is older than the installed one' };
  }
  if (order === 0 && !input.forceFull && !input.localBroken) {
    return { ...base, reason: 'the catalog is up to date' };
  }

  if (input.forceFull || input.localBroken) {
    return { ...base, kind: 'full', package: manifest.full };
  }

  const delta = manifest.deltas?.[installedVersion];
  if (delta) return { ...base, kind: 'delta', package: delta };

  return { ...base, kind: 'full', package: manifest.full };
}
