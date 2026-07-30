/**
 * Builds the equipment pack a fresh install starts with.
 *
 * Source of truth is the published catalog release: every product already has a
 * sanitised plan icon, so the starter inventory can place real silhouettes
 * without shipping harvested .se4/.rv4 symbol files.
 *
 *   npx tsx tools/build-starter-inventory.ts
 *   npx tsx tools/build-starter-inventory.ts --catalog catalog/releases/1.0.0.json
 *   npx tsx tools/build-starter-inventory.ts --out resources/starter-inventory
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog, CatalogProduct } from '../src/catalog/model.js';
import type { CatalogIcon } from '../src/catalog/icon.js';
import { emptyInventory, type InventoryItem } from '../src/inventory/model.js';
import { CATEGORY_LAYER, type Category } from '../src/inventory/classify.js';
import { PACK_FORMAT, PACK_MANIFEST, PACK_VERSION } from '../src/inventory/share.js';
import { INVENTORY_FILENAME } from '../src/inventory/store.js';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const catalogPath = arg('catalog', 'catalog/releases/1.0.0.json');
const outDir = arg('out', 'resources/starter-inventory');

/** Shop-facing department buckets for the starter palette. */
const DEPARTMENT_FOR: Record<string, string> = {
  projector: 'Video',
  screen: 'Video',
  'flat-panel': 'Video',
  camera: 'Video',
  'moving-light': 'Lighting',
  'par-light': 'Lighting',
  ellipsoidal: 'Lighting',
  'light-batten': 'Lighting',
  'light-tree': 'Lighting',
  'lighting-console': 'Lighting',
  speaker: 'Audio',
  subwoofer: 'Audio',
  mixer: 'Audio',
  podium: 'Furniture',
  riser: 'Staging',
  stairs: 'Staging',
  truss: 'Rigging',
  'truss-base': 'Rigging',
  drape: 'Drape',
  'drape-upright': 'Drape',
  lift: 'Staging',
  ladder: 'Staging',
  'table-round': 'Furniture',
  'table-rect': 'Furniture',
  chair: 'Furniture',
  desk: 'Furniture',
  person: 'Crew',
  'not-drawn': 'Unfiled',
};

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function productIcon(product: CatalogProduct & { icon?: CatalogIcon }): CatalogIcon | null {
  const icon = product.icon;
  if (!icon?.paths?.length) return null;
  if (!(icon.width > 0) || !(icon.height > 0)) return null;
  return icon;
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog & {
  products: Array<CatalogProduct & { icon?: CatalogIcon }>;
};

if (catalog.format !== 'groundplan-catalog') {
  console.error(`not a catalog: ${catalogPath}`);
  process.exit(1);
}

const addedAt = catalog.meta.released || new Date().toISOString();
const inventory = emptyInventory();
let withIcon = 0;
let skipped = 0;

for (const product of catalog.products) {
  if (product.deprecated) {
    skipped++;
    continue;
  }
  const icon = productIcon(product);
  if (!icon) {
    skipped++;
    continue;
  }

  const category = product.category as Category;
  const width = product.dimensions?.width ?? icon.width;
  const height = product.dimensions?.depth ?? icon.height;
  const item: InventoryItem = {
    id: `li_seed_${shortHash(product.id)}`,
    name: product.name,
    department: DEPARTMENT_FOR[category] ?? 'Equipment',
    category,
    width,
    height,
    sizeSource: 'symbol',
    timesSeen: 1,
    legacyTimesSeen: 1,
    provenanceIds: [],
    peakQuantity: 1,
    notes: `Starter shape from equipment catalog ${catalog.meta.version}.`,
    tracedIcon: {
      paths: icon.paths.map((path) => ({
        points: [...path.points],
        closed: path.closed,
      })),
      width: icon.width,
      height: icon.height,
    },
    mappedBy: 'user',
    mapReason: 'bundled starter catalog icon',
    addedAt,
  };

  // Sanity: category layer should exist for known categories.
  void CATEGORY_LAYER[category];
  inventory.items.push(item);
  withIcon++;
}

inventory.items.sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, INVENTORY_FILENAME), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
writeFileSync(
  join(outDir, PACK_MANIFEST),
  `${JSON.stringify(
    {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      exportedAt: addedAt,
      itemCount: inventory.items.length,
      assetCount: 0,
      label: `Groundplan starter equipment (${catalog.meta.version})`,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`wrote ${inventory.items.length} items to ${outDir} (skipped ${skipped}, icons ${withIcon})`);
