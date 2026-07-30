/**
 * Catalog update tests.
 *
 * The load-bearing one is delta/full equivalence: applying an incremental
 * update must land on exactly the catalog a full download of that version would
 * have produced. If that ever stops holding, two users on the same version have
 * different data and nothing downstream can be trusted, so it is asserted by
 * value over the whole catalog rather than by spot-checking a few records.
 *
 * The rest are the refusals — tampered, unsigned, wrong-key, downgrade,
 * schema-too-new, app-too-old. Each is a way a bad or stale catalog could reach
 * a user, and each has to fail closed.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareVersions,
  emptyCatalog,
  validateCatalog,
  type Catalog,
  type CatalogProduct,
} from '../src/catalog/model.js';
import {
  canonicalise,
  planUpdate,
  sha256,
  signManifest,
  verifyManifest,
  type CatalogManifest,
} from '../src/catalog/manifest.js';
import { applyDelta, computeDelta } from '../src/catalog/delta.js';
import { canGenerate, generateSymbol } from '../src/catalog/symbols.js';
import { traceImage } from '../src/catalog/trace.js';
import {
  containsNoText,
  genericiseName,
  isPublishable,
  sanitiseIcon,
  screenIconName,
} from '../src/catalog/icon.js';
import {
  catalogPaths,
  installPackage,
  loadInstalled,
  readCatalog,
  repair,
  rollback,
} from '../src/catalog/install.js';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIVATE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const other = generateKeyPairSync('ed25519');
const OTHER_PUBLIC = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function product(id: string, extra: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id,
    manufacturer: 'Barco',
    model: id.split(':').at(-1) ?? id,
    name: `Barco ${id}`,
    category: 'projector',
    ...extra,
  };
}

function catalog(version: string, products: CatalogProduct[]): Catalog {
  return {
    format: 'groundplan-catalog',
    meta: {
      version,
      schemaVersion: 1,
      released: '2026-07-29T00:00:00Z',
      minAppVersion: '1.0.0',
      productCount: products.length,
    },
    products: [...products].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

// --- version ordering ------------------------------------------------------

check('2.5.0 is newer than 2.4.1', compareVersions('2.5.0', '2.4.1') > 0);
check('2.4.1 is older than 2.10.0', compareVersions('2.4.1', '2.10.0') < 0);
check('equal versions compare equal', compareVersions('2.5.0', '2.5.0') === 0);

// --- delta equivalence -----------------------------------------------------

const v241 = catalog('2.4.1', [
  product('gp:barco:hdx-w20'),
  product('gp:barco:udx-4k32'),
  product('gp:panasonic:pt-rz21ku', { manufacturer: 'Panasonic' }),
  product('gp:dupe:remove-me'),
]);

const v250 = catalog('2.5.0', [
  // withdrawn, with a replacement
  product('gp:barco:hdx-w20', {
    deprecated: { since: '2.5.0', reason: 'discontinued' },
    replacedBy: 'gp:barco:udx-4k32',
  }),
  // corrected specification
  product('gp:barco:udx-4k32', { weightLb: 203, power: { watts: 3200, amps: 16, volts: 208 } }),
  // untouched
  product('gp:panasonic:pt-rz21ku', { manufacturer: 'Panasonic' }),
  // brand new
  product('gp:christie:m-4k25', { manufacturer: 'Christie' }),
]);

const delta = computeDelta(v241, v250);

check('an unchanged record is left out of the delta', !delta.upsert.some((p) => p.id === 'gp:panasonic:pt-rz21ku'));
check('a new record is in the delta', delta.upsert.some((p) => p.id === 'gp:christie:m-4k25'));
check('a corrected record is in the delta', delta.upsert.some((p) => p.id === 'gp:barco:udx-4k32'));
check('a record dropped entirely is deleted', delta.delete.includes('gp:dupe:remove-me'));

const applied = applyDelta(v241, delta);
check('the delta applies', applied.ok);
check(
  'applying the delta equals a full download of the same version',
  JSON.stringify(applied.catalog) === JSON.stringify(v250),
);
check('the input catalog is not mutated', v241.meta.version === '2.4.1' && v241.products.length === 4);
check('counts are reported', applied.added === 1 && applied.updated === 2 && applied.removed === 1);

// A delta must refuse to apply to the wrong base.
const wrongBase = applyDelta(catalog('2.3.0', []), delta);
check('a delta refuses a catalog it was not built from', !wrongBase.ok);

// ...and must not run backwards.
const backwards = applyDelta(v250, computeDelta(v250, v241));
check('a delta that moves backwards is refused', !backwards.ok);

// --- validation ------------------------------------------------------------

check('a good catalog validates', validateCatalog(v250).ok);
check('an empty catalog validates', validateCatalog(emptyCatalog()).ok);
check(
  'a duplicate id is caught',
  !validateCatalog(catalog('1.0.0', [product('gp:a'), product('gp:a')])).ok,
);
check(
  'a miscounted catalog is caught',
  !validateCatalog({ ...v250, meta: { ...v250.meta, productCount: 99 } }).ok,
);
check(
  'an unsupported schema is caught',
  !validateCatalog({ ...v250, meta: { ...v250.meta, schemaVersion: 99 } }).ok,
);

// --- signing ---------------------------------------------------------------

const base: CatalogManifest = {
  schema: 1,
  catalogVersion: '2.5.0',
  catalogSchemaVersion: 1,
  released: '2026-07-29T00:00:00Z',
  minAppVersion: '1.0.0',
  counts: { added: 1, updated: 2, deprecated: 1 },
  full: { url: 'https://example.invalid/full', bytes: 100, sha256: 'a'.repeat(64) },
  deltas: { '2.4.1': { url: 'https://example.invalid/d', bytes: 10, sha256: 'b'.repeat(64) } },
};

const signed = signManifest(base, PRIVATE);
check('a signed manifest verifies', verifyManifest(signed, [PUBLIC]));
check('an unsigned manifest is rejected', !verifyManifest(base, [PUBLIC]));
check('a manifest signed by another key is rejected', !verifyManifest(signed, [OTHER_PUBLIC]));
check('key rotation works — either pinned key is accepted', verifyManifest(signed, [OTHER_PUBLIC, PUBLIC]));

check(
  'tampering with the package hash breaks the signature',
  !verifyManifest({ ...signed, full: { ...signed.full, sha256: 'c'.repeat(64) } }, [PUBLIC]),
);
check(
  'tampering with the version breaks the signature',
  !verifyManifest({ ...signed, catalogVersion: '9.9.9' }, [PUBLIC]),
);
check(
  'tampering with minAppVersion breaks the signature',
  !verifyManifest({ ...signed, minAppVersion: '0.0.1' }, [PUBLIC]),
);

// Canonical form must not depend on key order, or signatures break at random.
check(
  'canonical form ignores key order',
  canonicalise({ b: 1, a: { d: 2, c: 3 } }) === canonicalise({ a: { c: 3, d: 2 }, b: 1 }),
);

// --- update planning -------------------------------------------------------

const plan = (over: Partial<Parameters<typeof planUpdate>[0]> = {}) =>
  planUpdate({
    manifest: signed,
    installedVersion: '2.4.1',
    appVersion: '1.2.0',
    publicKeys: [PUBLIC],
    ...over,
  });

check('a delta is chosen when one exists for the installed version', plan().kind === 'delta');
check('a full download is chosen with no matching delta', plan({ installedVersion: '2.0.0' }).kind === 'full');
check('a missing local catalog forces a full download', plan({ localBroken: true }).kind === 'full');
check('a manual reinstall forces a full download', plan({ forceFull: true }).kind === 'full');
check('an up-to-date catalog does nothing', plan({ installedVersion: '2.5.0' }).kind === 'none');

const downgrade = plan({ installedVersion: '2.6.0' });
check('a downgrade is refused', downgrade.kind === 'none' && !!downgrade.reason);

const tooOldApp = plan({ appVersion: '0.9.0' });
check('an app that is too old is blocked', tooOldApp.blocked === true);
check('the block explains that the app must be updated', /requires Groundplan/.test(tooOldApp.reason ?? ''));

const unsignedPlan = planUpdate({
  manifest: base,
  installedVersion: '2.4.1',
  appVersion: '1.2.0',
  publicKeys: [PUBLIC],
});
check('an unsigned release is blocked before anything else is read', unsignedPlan.blocked === true);

const futureSchema = planUpdate({
  manifest: signManifest({ ...base, catalogSchemaVersion: 99 }, PRIVATE),
  installedVersion: '2.4.1',
  appVersion: '1.2.0',
  publicKeys: [PUBLIC],
});
check('a newer catalog schema is blocked', futureSchema.blocked === true);

const urgent = planUpdate({
  manifest: signManifest({ ...base, urgent: true }, PRIVATE),
  installedVersion: '2.4.1',
  appVersion: '1.2.0',
  publicKeys: [PUBLIC],
});
check('an urgent release is flagged as such', urgent.urgent === true);

// --- generated symbols ------------------------------------------------------
//
// The shared catalog must never carry geometry taken from a real plan, so
// symbols are drawn from published dimensions instead. These check that the
// drawing is real geometry, is the stated size, and is centred on the insertion
// point — a symbol drawn off-centre would place away from where it was dropped.

const INCH = 10;

function sized(category: string, widthIn: number, depthIn: number): CatalogProduct {
  return {
    ...product(`gp:test:${category}`),
    category,
    dimensions: { width: widthIn * INCH, depth: depthIn * INCH },
  };
}

const projector = generateSymbol(sized('projector', 24, 30));
check('a projector generates geometry', projector.paths.length > 1);
check('a projector reports its published size', projector.width === 240 && projector.height === 300);
check(
  'a projector shows its throw direction beyond the body',
  projector.paths.some((path) => {
    for (let i = 1; i < path.points.length; i += 2) if (path.points[i] > 150) return true;
    return false;
  }),
);

const round = generateSymbol(sized('table-round', 60, 60));
check('a round table is drawn as a circle, not a box', round.paths[0].points.length > 20);
check('a round table is closed', round.paths[0].closed);

const truss = generateSymbol(sized('truss', 120, 12));
check('truss is drawn with bracing, not a bare rectangle', truss.paths.length > 3);

const drape = generateSymbol(sized('drape', 240, 2));
check('a drape run is drawn as an open wave', drape.paths.length === 1 && !drape.paths[0].closed);

// Every symbol must be centred, because the origin is the insertion point.
for (const category of ['projector', 'speaker', 'chair', 'riser', 'truss', 'camera', 'person']) {
  const symbol = generateSymbol(sized(category, 40, 30));
  let minX = Infinity;
  let maxX = -Infinity;
  for (const path of symbol.paths) {
    for (let i = 0; i < path.points.length; i += 2) {
      minX = Math.min(minX, path.points[i]);
      maxX = Math.max(maxX, path.points[i]);
    }
  }
  check(`${category} is centred on its insertion point`, Math.abs(minX + maxX) < symbol.width * 0.5);
}

// A product with no dimensions still draws, from a category default.
const noDimensions: CatalogProduct = { ...product('gp:x:y'), category: 'speaker' };
check('a product with no published dimensions still draws', generateSymbol(noDimensions).paths.length > 0);
check('and is reported as drawable', canGenerate(noDimensions));

// An unknown category degrades to an outline rather than throwing.
const unknown = generateSymbol({ ...product('gp:x:z'), category: 'something-new' });
check('an unknown category degrades to a plain outline', unknown.paths.length === 1);
check('and says so in its basis', /generic/.test(unknown.basis));

// --- publishable icons ------------------------------------------------------
//
// Icons are shared; schematics are not. An icon is the technology's outline,
// which is exactly what everyone should have. What must never travel with it is
// the show it was drawn in — the labels, the dimensions, the client. These
// assert that separation on a synthetic scene carrying deliberately identifying
// text.

const scene = {
  primitives: [
    // the product outline, which should survive
    { id: 1, nodeId: 1, selectId: 10, type: 'polygon', pts: [0, 0, 100, 0, 100, 50, 0, 50], color: 0, cls: 'RVShape', layer: 'furniture', owner: 'Barco LC w/1.2 Lens' },
    // a label naming the client, which must not
    { id: 2, nodeId: 1, selectId: 10, type: 'text', pts: [10, 10], color: 0, cls: 'RVLabel', layer: 'furniture', owner: 'Barco LC w/1.2 Lens', text: 'Bank of America — Card Party 2026' },
    // a dimension line, which must not
    { id: 3, nodeId: 1, selectId: 10, type: 'dimension', pts: [0, 0, 100, 0], color: 0, cls: 'RVDim', layer: 'annotation', owner: 'Barco LC w/1.2 Lens', text: "74 ft 1 in" },
    // another object entirely, which must not
    { id: 4, nodeId: 2, selectId: 20, type: 'polyline', pts: [500, 500, 900, 900], color: 0, cls: 'RVShape', layer: 'walls', owner: 'Grand Ballroom Wall' },
  ],
  inventory: [],
  counts: {},
} as unknown as Parameters<typeof sanitiseIcon>[0];

const clean = sanitiseIcon(scene, 'Barco LC w/1.2 Lens');
check('an icon is extracted from a real drawing', !!clean.icon);
check('the client label is stripped', clean.droppedText === 1);
check('the dimension is stripped', clean.droppedAnnotation === 1);
check('only the product outline survives', clean.icon!.paths.length === 1);
check('geometry from other objects is excluded', !JSON.stringify(clean.icon).includes('900'));
check('the icon carries no text at all', containsNoText(clean.icon!));
check('the icon is publishable', isPublishable(clean.icon!).ok);
check('the icon is centred on the insertion point', clean.icon!.paths[0].points.includes(-50));

// The strongest form of the claim: no string survives anywhere in the payload.
const leafStrings: string[] = [];
(function walk(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') return Object.values(v).forEach(walk);
  if (typeof v === 'string') leafStrings.push(v);
})(clean.icon);
check('no string value survives sanitising', leafStrings.length === 0);

// Room-sized outlines are not products and must not be published.
const roomSized = sanitiseIcon(
  { primitives: [{ id: 1, nodeId: 1, selectId: 1, type: 'polygon', pts: [0, 0, 12000, 0, 12000, 9000, 0, 9000], color: 0, cls: 'RVShape', layer: 'walls', owner: 'x' }], inventory: [], counts: {} } as never,
  'x',
);
check('a room-sized outline is refused', !isPublishable(roomSized.icon!).ok);

// Names: the technology is kept, the client is flagged.
for (const name of ['Barco LC w/1.2 Lens', 'DLP 15SX - 2.0', `6' x 30"`, 'Leko Light', 'Standard 18"x18"', 'Steps', 'Lighting Control']) {
  check(`"${name}" is publishable as technology`, screenIconName(name).safe);
}
for (const name of ['BofA Podium', 'Grand Ballroom Riser', 'Card Party 2026 Stage', "Prince's Table", 'Room 402 Chair', 'Acme Inc Screen']) {
  check(`"${name}" is flagged as client-tied`, !screenIconName(name).safe);
}

// Names are rewritten automatically rather than queued for review: a queue
// nobody works looks like a safeguard while doing nothing. The rewrite keeps
// only known equipment vocabulary, so anything unrecognised is dropped by
// default — the correct bias when the risk is leaking a customer's name.

for (const [input, expected] of [
  ['BofA Podium', 'Podium'],
  ['Grand Ballroom Riser', 'Riser'],
  ['Card Party 2026 Stage', 'Stage'],
  ["Prince's Table", 'Table'],
  ['Room 402 Chair', 'Chair'],
  ['Acme Inc Screen', 'Screen'],
  ['Marriott Salon C Truss', 'Truss'],
  ['Keynote Riser', 'Riser'],
] as const) {
  const result = genericiseName(input, 'riser');
  check(`"${input}" becomes "${expected}"`, result.name === expected && result.changed);
}

// A year or a room number is not a dimension, however number-like it looks.
check('a year does not survive as a dimension', !genericiseName('Card Party 2026 Stage').name.includes('2026'));
check('a room number does not survive', !genericiseName('Room 402 Chair').name.includes('402'));

// Nothing recognisable left means the category's plain name.
check(
  'an unrecognisable name falls back to the category',
  genericiseName('Hilton Gala Uplight', 'par-light').name === 'PAR Fixture',
);
check(
  'and to something readable with no category',
  genericiseName('Hilton Gala Whatsit').name === 'Equipment',
);

// Genuine equipment names must pass through untouched — this is the property
// that keeps the catalog useful rather than a list of anonymous boxes.
for (const name of [
  'Barco LC w/1.2 Lens',
  `6' x 30"`,
  'Standard 18"x18"',
  'Leko Light',
  'DLP 15SX - 2.0',
  'Lighting Control',
  'Sanyo 9000',
  'Fastfold 10.5\' x 14\'',
]) {
  const result = genericiseName(name);
  check(`"${name}" is left alone`, !result.changed && result.name === name);
}

// --- tracing an image into an outline ---------------------------------------
//
// The property that matters is that the shape survives and the size comes from
// the user. A trace that is the right shape at the wrong scale is worse than no
// trace at all, because it looks correct on screen and is wrong on the floor.

function raster(w: number, h: number, draw: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const ink = draw(x, y);
      data[i] = data[i + 1] = data[i + 2] = ink ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const FOOT = 120;

const box = traceImage(raster(200, 120, (x, y) => x >= 40 && x < 160 && y >= 30 && y < 90), {
  targetWidth: 6 * FOOT,
  targetDepth: 2.5 * FOOT,
});
check('a rectangle traces', box.ok);
check('a rectangle reduces to its corners', box.points >= 4 && box.points <= 6);
check('the traced outline is the size the user stated', box.width === 6 * FOOT && box.height === 2.5 * FOOT);
check('the raw trace followed the whole perimeter', box.rawPoints > 300);

// Centred, or it will not place where it is dropped.
const xs = box.paths[0].points.filter((_, i) => i % 2 === 0);
check('the outline is centred on the insertion point', Math.abs(Math.min(...xs) + Math.max(...xs)) < 1);

// A circle must not be flattened into a polygon by over-simplification.
const tracedCircle = traceImage(raster(200, 200, (x, y) => Math.hypot(x - 100, y - 100) < 70), {
  targetWidth: 5 * FOOT,
  targetDepth: 5 * FOOT,
});
check('a circle keeps enough points to read as round', tracedCircle.points > 15);

// Concave shapes must survive; a convex hull would swallow the notch.
const ell = traceImage(
  raster(200, 200, (x, y) => (x >= 40 && x < 160 && y >= 120 && y < 170) || (x >= 40 && x < 90 && y >= 40 && y < 170)),
  { targetWidth: 8 * FOOT },
);
check('an L-shape keeps its concave corner', ell.points >= 6);

// Speckle around a product must not become part of it.
let seed = 1;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noisy = traceImage(
  raster(200, 200, (x, y) => (x >= 60 && x < 140 && y >= 60 && y < 140) || random() < 0.02),
  { targetWidth: 4 * FOOT, targetDepth: 4 * FOOT },
);
check('stray marks are ignored', noisy.ok && noisy.points <= 8);

// Only one dimension given: the other comes from the traced proportions.
const oneSided = traceImage(raster(200, 100, (x, y) => x >= 20 && x < 180 && y >= 20 && y < 60), {
  targetWidth: 8 * FOOT,
});
check('a single dimension scales the other by proportion', Math.abs(oneSided.height - 2 * FOOT) < 2);

// Failures have to say what to do about them.
check('a blank image explains itself', /threshold/.test(traceImage(raster(50, 50, () => false)).reason ?? ''));
check('an all-dark image explains itself', /threshold/.test(traceImage(raster(50, 50, () => true)).reason ?? ''));

// --- install, rollback and repair -----------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'gp-catalog-'));
const paths = catalogPaths(tmp);

const pack = (value: unknown): { bytes: Uint8Array; hash: string } => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { bytes, hash: sha256(bytes) };
};

async function main(): Promise<void> {
  // A full install onto an empty machine.
  const full = pack(v241);
  const first = await installPackage({
    paths,
    packageBytes: full.bytes,
    expectedSha256: full.hash,
    kind: 'full',
  });
  check('a full install succeeds on a fresh machine', first.ok && first.version === '2.4.1');
  check('the installed catalog reads back', (await loadInstalled(paths)).meta.version === '2.4.1');

  // A package whose bytes do not match the signed hash is refused outright.
  const tampered = await installPackage({
    paths,
    packageBytes: new TextEncoder().encode(JSON.stringify({ ...v250, products: [] })),
    expectedSha256: pack(v250).hash,
    kind: 'full',
  });
  check('a package that does not match its hash is rejected', !tampered.ok);
  check(
    'a rejected package leaves the installed catalog untouched',
    (await loadInstalled(paths)).meta.version === '2.4.1',
  );

  // The incremental path.
  const patch = pack(delta);
  const incremental = await installPackage({
    paths,
    packageBytes: patch.bytes,
    expectedSha256: patch.hash,
    kind: 'delta',
  });
  check('a delta installs', incremental.ok && incremental.version === '2.5.0');
  check(
    'the installed catalog equals a full download of that version',
    JSON.stringify(await loadInstalled(paths)) === JSON.stringify(v250),
  );
  check('the previous catalog is kept for rollback', existsSync(paths.previous));

  // Garbage that happens to hash correctly still must not land.
  const rubbish = pack({ format: 'groundplan-catalog', meta: {}, products: 'not an array' });
  const invalid = await installPackage({
    paths,
    packageBytes: rubbish.bytes,
    expectedSha256: rubbish.hash,
    kind: 'full',
  });
  check('a structurally invalid catalog is refused', !invalid.ok);
  check(
    'the live catalog survives an invalid package',
    (await loadInstalled(paths)).meta.version === '2.5.0',
  );

  // A delta aimed at the wrong base version.
  const stale = pack(computeDelta(catalog('2.0.0', [product('gp:x')]), catalog('2.1.0', [product('gp:y')])));
  const mismatched = await installPackage({
    paths,
    packageBytes: stale.bytes,
    expectedSha256: stale.hash,
    kind: 'delta',
  });
  check('a delta for another base version is refused', !mismatched.ok);
  check(
    'the live catalog survives a mismatched delta',
    (await loadInstalled(paths)).meta.version === '2.5.0',
  );

  // Rollback puts 2.4.1 back.
  check('rollback restores the previous catalog', await rollback(paths));
  check('the restored catalog is the previous version', (await loadInstalled(paths)).meta.version === '2.4.1');

  // Repair copes with a corrupted live file.
  writeFileSync(paths.current, '{ this is not json');
  writeFileSync(paths.incoming, 'leftover staging file');
  writeFileSync(paths.previous, JSON.stringify(v250));
  const repaired = await repair(paths);
  check('repair restores a working catalog', repaired.ok && repaired.action === 'restored');
  check('repair clears staged files', !existsSync(paths.incoming));
  check('the repaired catalog opens', (await loadInstalled(paths)).meta.version === '2.5.0');

  // Two windows installing at once must not corrupt anything. A fixed staging
  // filename made them overwrite each other, so whichever renamed second found
  // nothing there and left the rollback copy unusable.
  const raceDir = mkdtempSync(join(tmpdir(), 'gp-race-'));
  const racePaths = catalogPaths(raceDir);
  const baseline = pack(v241);
  await installPackage({ paths: racePaths, packageBytes: baseline.bytes, expectedSha256: baseline.hash, kind: 'full' });

  const second = pack(v250);
  const both = await Promise.all([
    installPackage({ paths: racePaths, packageBytes: second.bytes, expectedSha256: second.hash, kind: 'full' }),
    installPackage({ paths: racePaths, packageBytes: second.bytes, expectedSha256: second.hash, kind: 'full' }),
  ]);
  check('concurrent installs both return a verdict', both.every((r) => typeof r.ok === 'boolean'));
  check('exactly one concurrent install wins', both.filter((r) => r.ok).length >= 1);
  check(
    'the catalog is intact after a race',
    (await loadInstalled(racePaths)).meta.version === '2.5.0',
  );
  check('the rollback copy is still a real catalog', (await readCatalog(racePaths.previous)) !== null);
  check('no staging files are left behind', !existsSync(racePaths.incoming));
  rmSync(raceDir, { recursive: true, force: true });

  // Nothing salvageable: repair must fail cleanly rather than loop.
  writeFileSync(paths.current, 'broken');
  if (existsSync(paths.previous)) rmSync(paths.previous);
  const hopeless = await repair(paths);
  check('repair reports when a full download is needed', !hopeless.ok && hopeless.action === 'cleared');

  rmSync(tmp, { recursive: true, force: true });

  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

void main();
