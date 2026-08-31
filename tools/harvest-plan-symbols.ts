/**
 * Harvests drawn symbol silhouettes from a plan into an inventory.
 *
 * Used to pull real outlines (doors, Barco, Plasma, etc.) out of a show file
 * so Insert / Inventory place the real shape instead of a sized box.
 *
 *   npx tsx tools/harvest-plan-symbols.ts \
 *     --plan "/path/to/show.rv4" \
 *     --inventory resources/starter-inventory/inventory.json
 *
 *   npx tsx tools/harvest-plan-symbols.ts --plan … --inventory … --only "Door,Barco,Plasma"
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { loadFile } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { listSymbols } from '../src/format/symbol.js';
import { walk } from '../src/format/rv.js';
import { sanitiseIcon, type CatalogIcon } from '../src/catalog/icon.js';
import { classify } from '../src/inventory/classify.js';
import { doorIcon, doorSwingFromName } from '../src/format/synthesize.js';
import {
  emptyInventory,
  normaliseName,
  type Inventory,
  type InventoryItem,
} from '../src/inventory/model.js';
import { INVENTORY_ASSET_DIRECTORY } from '../src/inventory/store.js';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** Synthetic circle when the plan names a round deck but drew no outline. */
function circleIcon(width: number, height: number, segments = 48): CatalogIcon {
  const rx = width / 2;
  const ry = height / 2;
  const points: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(Math.round(rx * Math.cos(a) * 10) / 10, Math.round(ry * Math.sin(a) * 10) / 10);
  }
  return { paths: [{ points, closed: true }], width, height };
}

/** Axis-aligned box when geometry is a husk but the name still needs a stamp. */
function boxIcon(width: number, height: number): CatalogIcon {
  const hw = width / 2;
  const hh = height / 2;
  return {
    paths: [{ points: [-hw, -hh, hw, -hh, hw, hh, -hw, hh], closed: true }],
    width,
    height,
  };
}

const planPath = resolve(arg('plan') ?? '');
const inventoryPath = resolve(arg('inventory') ?? '');
const onlyRaw = arg('only');
const only = onlyRaw
  ? onlyRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;

if (!planPath || !existsSync(planPath)) {
  console.error(
    'usage: harvest-plan-symbols --plan <file.rv4> --inventory <inventory.json> [--only Door,Barco]',
  );
  process.exit(1);
}
if (!inventoryPath) {
  console.error('missing --inventory path');
  process.exit(1);
}

const loaded = loadFile(planPath);
const doc = loaded.document;
const scene = buildScene(doc);

/** Prefer listSymbols, then any named RVShape (trimmed) with a usable bounds. */
const bySymbol = new Map(listSymbols(doc).map((s) => [normaliseName(s.name), s]));
for (const node of walk(doc)) {
  if (node.cls !== 'RVShape') continue;
  const raw = node.labels.find((l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l));
  const name = raw?.trim();
  if (!name) continue;
  const key = normaliseName(name);
  if (bySymbol.has(key)) continue;
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;
  if (width > 0 && height > 0) bySymbol.set(key, { name, width, height });
}
const symbols = [...bySymbol.values()].sort((a, b) => a.name.localeCompare(b.name));

const inventory: Inventory = existsSync(inventoryPath)
  ? (JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory)
  : emptyInventory();

const byName = new Map(inventory.items.map((i) => [normaliseName(i.name), i]));
const at = new Date().toISOString();
const assetRoot = join(dirname(inventoryPath), INVENTORY_ASSET_DIRECTORY);
mkdirSync(assetRoot, { recursive: true });

const planBytes = readFileSync(planPath);
const planHash = createHash('sha256').update(planBytes).digest('hex');
const managedName = `card-party-symbols-${planHash.slice(0, 16)}.rv4`;
const managedPath = join(assetRoot, managedName);
if (!existsSync(managedPath)) copyFileSync(planPath, managedPath);
const relativeAsset = `${INVENTORY_ASSET_DIRECTORY}/${managedName}`;

let added = 0;
let updated = 0;
let skipped = 0;
let synthetic = 0;

const wanted = symbols.filter((sym) => {
  if (!only) return true;
  const name = sym.name.toLowerCase();
  return only.some((needle) => name.includes(needle));
});

for (const sym of wanted) {
  if (/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)$/i.test(sym.name)) {
    skipped++;
    continue;
  }

  let icon = sanitiseIcon(scene, sym.name).icon;
  let source = 'plan outline';
  if (!icon?.paths?.length) {
    const classifiedEmpty = classify(sym.name);
    if (classifiedEmpty.category === 'door') {
      icon = doorIcon(sym.width, sym.height, doorSwingFromName(sym.name));
      source = 'synthetic door (empty geometry in plan)';
      synthetic++;
    } else if (/\bcircle\b|\bround\b/i.test(sym.name)) {
      icon = circleIcon(sym.width, sym.height);
      source = 'synthetic circle';
      synthetic++;
    } else {
      icon = boxIcon(sym.width, sym.height);
      source = 'synthetic box (empty geometry in plan)';
      synthetic++;
    }
  }

  const width = Math.max(sym.width, icon.width);
  const height = Math.max(sym.height, icon.height);
  const classified = classify(sym.name);
  const key = normaliseName(sym.name);
  const existing = byName.get(key);
  const tracedIcon = {
    paths: icon.paths.map((p) => ({ points: [...p.points], closed: p.closed })),
    width: icon.width,
    height: icon.height,
  };
  const asset = {
    relativePath: relativeAsset,
    hash: planHash,
    sourcePath: planPath,
  };

  if (!existing) {
    const item: InventoryItem = {
      id: `li_harvest_${createHash('sha1').update(sym.name).digest('hex').slice(0, 10)}`,
      name: sym.name,
      department: classified.category === 'not-drawn' ? 'Venue' : undefined,
      category: classified.category,
      width,
      height,
      sizeSource: 'symbol',
      symbolPath: managedPath,
      symbolName: sym.name,
      symbolAsset: asset,
      tracedIcon,
      mappedBy: 'user',
      mapReason: `harvested from ${basename(planPath)} (${source})`,
      timesSeen: 1,
      legacyTimesSeen: 1,
      provenanceIds: [],
      peakQuantity: 1,
      notes: `Symbol harvested from ${basename(planPath)}.`,
      addedAt: at,
    };
    inventory.items.push(item);
    byName.set(key, item);
    added++;
    console.log(
      `  add   ${sym.name} (${(width / 120).toFixed(2)}×${(height / 120).toFixed(2)} ft, ${source})`,
    );
  } else {
    existing.tracedIcon = tracedIcon;
    existing.width = width;
    existing.height = height;
    existing.sizeSource = 'symbol';
    existing.symbolPath = managedPath;
    existing.symbolName = sym.name;
    existing.symbolAsset = asset;
    existing.mappedBy = 'user';
    existing.mapReason = `harvested from ${basename(planPath)} (${source})`;
    if (!existing.category || existing.category === 'not-drawn') {
      existing.category = classified.category;
    }
    updated++;
    console.log(`  update ${sym.name} (${source})`);
  }
}

inventory.items.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(dirname(inventoryPath), { recursive: true });
writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

console.log(
  `\n${basename(inventoryPath)}: +${added} added, ${updated} updated, ${skipped} skipped, ${synthetic} synthetic outlines`,
);
console.log(`symbol file: ${managedPath}`);
