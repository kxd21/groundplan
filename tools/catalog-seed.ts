/**
 * Builds catalog source products from a local inventory.
 *
 * This is how the shared catalog gets its first contents: take what a real shop
 * has accumulated, keep the parts that describe equipment, and drop everything
 * that describes their business or their clients.
 *
 * Kept — the technology:
 *   name (genericised if it names a customer), category, footprint, and the
 *   drawn icon, sanitised to geometry only.
 *
 * Dropped — the company:
 *   how many they own, what they paid, where it is stored, which shows it is on,
 *   notes, barcodes, and the path to the plan any icon came from.
 *
 *   npx tsx tools/catalog-seed.ts [--inventory path] [--out catalog/products.json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

import { loadBuffer } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { genericiseName, isPublishable, sanitiseIcon, type CatalogIcon } from '../src/catalog/icon.js';
import type { CatalogProduct } from '../src/catalog/model.js';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const inventoryPath = arg(
  'inventory',
  join(homedir(), 'Library/Application Support/Groundplan/inventory.json'),
);
const outPath = arg('out', 'catalog/products.json');

if (!existsSync(inventoryPath)) {
  console.error(`no inventory at ${inventoryPath}`);
  process.exit(1);
}

interface LocalItem {
  name: string;
  category?: string;
  width?: number;
  height?: number;
  symbolPath?: string;
  symbolName?: string;
  mappedBy?: string;
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as { items: LocalItem[] };

/** A stable, readable id: `gp:<category>:<slug>`. */
function idFor(name: string, category: string, taken: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  let id = `gp:${category}:${slug}`;
  let n = 2;
  while (taken.has(id)) id = `gp:${category}:${slug}-${n++}`;
  taken.add(id);
  return id;
}

const sceneCache = new Map<string, ReturnType<typeof buildScene>>();
function sceneFor(path: string): ReturnType<typeof buildScene> | null {
  if (sceneCache.has(path)) return sceneCache.get(path)!;
  try {
    const scene = buildScene(loadBuffer(readFileSync(path), path).document);
    sceneCache.set(path, scene);
    return scene;
  } catch {
    return null;
  }
}

const products: CatalogProduct[] = [];
const taken = new Set<string>();
let withIcon = 0;
let renamed = 0;
let skipped = 0;
const renames: Array<[string, string]> = [];

for (const item of inventory.items) {
  // Only items that carry their own drawn symbol are seeded. An item that
  // merely borrowed another's shape adds a name and nothing else.
  if (!item.symbolPath || item.mappedBy === 'auto') {
    skipped++;
    continue;
  }

  const category = item.category ?? 'not-drawn';
  if (category === 'not-drawn') {
    skipped++;
    continue;
  }

  const generic = genericiseName(item.name, category);
  if (generic.changed) {
    renamed++;
    renames.push([item.name, generic.name]);
  }

  // Symbol paths are persisted relative to the inventory file so they stay
  // portable between machines; resolve them the same way the app does.
  const symbolFile = isAbsolute(item.symbolPath)
    ? item.symbolPath
    : join(dirname(inventoryPath), item.symbolPath);

  let icon: CatalogIcon | undefined;
  const scene = existsSync(symbolFile) ? sceneFor(symbolFile) : null;
  if (scene) {
    const result = sanitiseIcon(scene, item.symbolName ?? item.name);
    if (result.icon && isPublishable(result.icon).ok) {
      icon = result.icon;
      withIcon++;
    }
  }

  const product: CatalogProduct & { icon?: CatalogIcon } = {
    id: idFor(generic.name, category, taken),
    // Seeded entries carry no verified manufacturer yet; a contributor can
    // split the name into manufacturer and model in a later correction.
    manufacturer: 'Unverified',
    model: generic.name,
    name: generic.name,
    category,
    dimensions: item.width && item.height ? { width: item.width, depth: item.height } : undefined,
    tags: ['seeded'],
  };
  if (icon) product.icon = icon;

  products.push(product);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(products, null, 2)}\n`, 'utf8');

console.log(`seeded ${products.length} products from ${inventory.items.length} inventory items`);
console.log(`  with a drawn icon    ${withIcon}`);
console.log(`  names genericised    ${renamed}`);
for (const [from, to] of renames.slice(0, 10)) console.log(`      "${from}" -> "${to}"`);
console.log(`  skipped              ${skipped} (no own symbol, or never drawn)`);
console.log(`  written to           ${outPath}`);
