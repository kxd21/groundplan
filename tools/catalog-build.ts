/**
 * Builds and signs a catalog release.
 *
 * Reads the source products, writes the full package, generates a delta from
 * every previous release, and signs one manifest covering all of it. Run by CI
 * on a tag, and runnable by hand for a dry run.
 *
 *   npx tsx tools/catalog-build.ts --version 1.1.0 [--key path] [--out dist]
 *
 * The signing key never appears in the repository. CI supplies it through an
 * environment variable; locally it is read from a file that is git-ignored.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions, validateCatalog, type Catalog, type CatalogProduct } from '../src/catalog/model.js';
import { computeDelta } from '../src/catalog/delta.js';
import { sha256, signManifest, type CatalogManifest, type PackageRef } from '../src/catalog/manifest.js';
import { containsNoText } from '../src/catalog/icon.js';

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined && fallback === undefined) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return value ?? fallback!;
}

const version = arg('version');
const sourceDir = arg('source', 'catalog');
const outDir = arg('out', 'dist');
const keyPath = arg('key', 'catalog-signing-key.pem');
const baseUrl = arg('base-url', 'https://github.com/kxd21/groundplan-catalog/releases/download');

const privateKey = process.env.CATALOG_SIGNING_KEY ?? (existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : '');
if (!privateKey) {
  console.error(
    `no signing key. Set CATALOG_SIGNING_KEY, or place the key at ${keyPath}.\n` +
      `Generate one with: npx tsx tools/catalog-keygen.ts`,
  );
  process.exit(1);
}

// --- source ----------------------------------------------------------------

const productsFile = join(sourceDir, 'products.json');
if (!existsSync(productsFile)) {
  console.error(`no products at ${productsFile}`);
  process.exit(1);
}

const products = JSON.parse(readFileSync(productsFile, 'utf8')) as CatalogProduct[];
if (!Array.isArray(products)) {
  console.error('products.json must be an array');
  process.exit(1);
}

/**
 * A last gate before anything is published.
 *
 * The icon sanitiser already drops text, but this release is about to be
 * downloaded by everyone, so the property is asserted again here rather than
 * assumed to have held upstream.
 */
let iconsChecked = 0;
for (const product of products) {
  const icon = (product as unknown as { icon?: Parameters<typeof containsNoText>[0] }).icon;
  if (!icon) continue;
  iconsChecked++;
  if (!containsNoText(icon)) {
    console.error(`refusing to publish: the icon for ${product.id} contains non-numeric data`);
    process.exit(1);
  }
}

const catalog: Catalog = {
  format: 'groundplan-catalog',
  meta: {
    version,
    schemaVersion: 1,
    released: new Date().toISOString(),
    minAppVersion: arg('min-app', '1.0.0'),
    productCount: products.length,
  },
  products: [...products].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
};

const validation = validateCatalog(catalog);
if (!validation.ok) {
  console.error('the catalog is not valid:');
  for (const problem of validation.problems) console.error(`  ${problem}`);
  process.exit(1);
}

// --- packages --------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const write = (name: string, value: unknown): PackageRef => {
  const body = JSON.stringify(value);
  const path = join(outDir, name);
  writeFileSync(path, body, 'utf8');
  return { url: `${baseUrl}/v${version}/${name}`, bytes: Buffer.byteLength(body), sha256: sha256(body) };
};

const full = write('full.json', catalog);

// Deltas from every earlier release that is still on disk, so a user two or
// three versions behind still gets an incremental update rather than the lot.
const releasesDir = join(sourceDir, 'releases');
const deltas: Record<string, PackageRef> = {};
let counts = { added: products.length, updated: 0, deprecated: 0 };

if (existsSync(releasesDir)) {
  const earlier = readdirSync(releasesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(releasesDir, f), 'utf8')) as Catalog)
    .filter((c) => compareVersions(c.meta.version, version) < 0)
    .sort((a, b) => compareVersions(b.meta.version, a.meta.version));

  for (const previous of earlier) {
    const delta = computeDelta(previous, catalog);
    deltas[previous.meta.version] = write(`from-${previous.meta.version}.json`, delta);
    // The newest previous release is the one that describes this release.
    if (previous === earlier[0]) {
      counts = {
        added: delta.upsert.filter((p) => !previous.products.some((q) => q.id === p.id)).length,
        updated: delta.upsert.filter((p) => previous.products.some((q) => q.id === p.id)).length,
        deprecated: delta.deprecate.length,
      };
    }
  }
}

const manifest: CatalogManifest = signManifest(
  {
    schema: 1,
    catalogVersion: version,
    catalogSchemaVersion: 1,
    released: catalog.meta.released,
    minAppVersion: catalog.meta.minAppVersion,
    urgent: process.argv.includes('--urgent'),
    channel: 'stable',
    counts,
    full,
    deltas: Object.keys(deltas).length > 0 ? deltas : undefined,
  },
  privateKey,
);

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// Keep this release so the next build can diff against it.
mkdirSync(releasesDir, { recursive: true });
writeFileSync(join(releasesDir, `${version}.json`), JSON.stringify(catalog), 'utf8');

console.log(`catalog ${version}`);
console.log(`  products    ${products.length} (${iconsChecked} with icons, all verified text-free)`);
console.log(`  full        ${(full.bytes / 1024).toFixed(1)} KB`);
for (const [from, ref] of Object.entries(deltas)) {
  console.log(`  from ${from.padEnd(8)} ${(ref.bytes / 1024).toFixed(1)} KB`);
}
console.log(`  counts      +${counts.added} new, ${counts.updated} updated, ${counts.deprecated} deprecated`);
console.log(`  signed      ${manifest.signature?.slice(0, 16)}…`);
console.log(`  written to  ${outDir}/`);
