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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Catalog, CatalogProduct } from '../src/catalog/model.js';
import type { CatalogIcon } from '../src/catalog/icon.js';
import { emptyInventory, normaliseName, type InventoryItem } from '../src/inventory/model.js';
import { CATEGORY_LAYER, classify, type Category } from '../src/inventory/classify.js';
import { PACK_FORMAT, PACK_MANIFEST, PACK_VERSION } from '../src/inventory/share.js';
import { INVENTORY_FILENAME } from '../src/inventory/store.js';
import { UNITS_PER_INCH } from '../src/format/constants.js';

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
  door: 'Venue',
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

function roundPts(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Closed rectangle icon centred on the origin. */
function rectIcon(width: number, height: number): CatalogIcon {
  const hw = width / 2;
  const hh = height / 2;
  return {
    paths: [
      {
        points: [-hw, -hh, hw, -hh, hw, hh, -hw, hh].map(roundPts),
        closed: true,
      },
    ],
    width,
    height,
  };
}

/** Closed circle icon for banquet / cocktail rounds. */
function circleIcon(diameter: number, segments = 48): CatalogIcon {
  const r = diameter / 2;
  const points: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(roundPts(r * Math.cos(a)), roundPts(r * Math.sin(a)));
  }
  return { paths: [{ points, closed: true }], width: diameter, height: diameter };
}

/**
 * Plan-view chair: seat pad + back rail. Reads as seating at palette scale,
 * not a blank square.
 */
function chairIcon(width: number, depth: number): CatalogIcon {
  const hw = width / 2;
  const hd = depth / 2;
  const back = Math.min(depth * 0.18, 28);
  const seatFront = hd - back * 0.15;
  const seatBack = -hd + back;
  return {
    paths: [
      {
        // Seat
        points: [-hw * 0.92, seatBack, hw * 0.92, seatBack, hw * 0.85, seatFront, -hw * 0.85, seatFront].map(
          roundPts,
        ),
        closed: true,
      },
      {
        // Back
        points: [-hw * 0.88, -hd, hw * 0.88, -hd, hw * 0.88, -hd + back, -hw * 0.88, -hd + back].map(roundPts),
        closed: true,
      },
    ],
    width,
    height: depth,
  };
}

/** Half-disk buffet / serpentine section (flat edge along −Y). */
function halfRoundIcon(diameter: number, segments = 32): CatalogIcon {
  const r = diameter / 2;
  const points: number[] = [-r, 0, r, 0];
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI - (i / segments) * Math.PI;
    points.push(roundPts(r * Math.cos(a)), roundPts(r * Math.sin(a)));
  }
  return { paths: [{ points, closed: true }], width: diameter, height: r };
}

type HospitalitySpec = {
  name: string;
  category: Category;
  widthIn: number;
  depthIn: number;
  kind: 'chair' | 'round' | 'rect' | 'half-round';
  notes: string;
};

/**
 * Hotel / convention / ballroom furniture that shops place every week.
 * Sizes follow US banquet rental norms (inches). Catalog icons alone miss most
 * of these names, so the starter pack synthesises honest plan silhouettes.
 */
const HOSPITALITY_FURNITURE: HospitalitySpec[] = [
  // —— Chairs ——
  {
    name: 'Banquet Chair 18" × 20"',
    category: 'chair',
    widthIn: 18,
    depthIn: 20,
    kind: 'chair',
    notes: 'Standard hotel / convention stack banquet chair.',
  },
  {
    name: 'Chiavari Chair',
    category: 'chair',
    widthIn: 16,
    depthIn: 17,
    kind: 'chair',
    notes: 'Chiavari / ballroom chair used for weddings and upscale banquets.',
  },
  {
    name: 'Folding Chair',
    category: 'chair',
    widthIn: 18,
    depthIn: 19,
    kind: 'chair',
    notes: 'Utility folding chair for overflow and outdoor seating.',
  },
  {
    name: 'Conference Chair',
    category: 'chair',
    widthIn: 24,
    depthIn: 24,
    kind: 'chair',
    notes: 'Padded conference / meeting-room chair.',
  },
  {
    name: 'Barstool',
    category: 'chair',
    widthIn: 14,
    depthIn: 14,
    kind: 'chair',
    notes: 'Bar / cocktail stool footprint for highboy layouts.',
  },
  {
    name: 'Armchair',
    category: 'chair',
    widthIn: 28,
    depthIn: 30,
    kind: 'chair',
    notes: 'Lounge armchair for lobby and conversational seating.',
  },
  // —— Round / cocktail ——
  {
    name: 'Cocktail Round 30"',
    category: 'table-round',
    widthIn: 30,
    depthIn: 30,
    kind: 'round',
    notes: '30″ cocktail / cabaret top (standing or low).',
  },
  {
    name: 'Highboy 30"',
    category: 'table-round',
    widthIn: 30,
    depthIn: 30,
    kind: 'round',
    notes: '30″ highboy / tall cocktail — same plan footprint as a 30″ round.',
  },
  {
    name: 'Cocktail Round 36"',
    category: 'table-round',
    widthIn: 36,
    depthIn: 36,
    kind: 'round',
    notes: '36″ cocktail round for receptions.',
  },
  {
    name: 'Banquet Round 60"',
    category: 'table-round',
    widthIn: 60,
    depthIn: 60,
    kind: 'round',
    notes: 'Industry-standard 60″ banquet round (8–10 chairs).',
  },
  {
    name: 'Banquet Round 72"',
    category: 'table-round',
    widthIn: 72,
    depthIn: 72,
    kind: 'round',
    notes: '72″ banquet round for large parties (10–12 chairs).',
  },
  // —— Rectangular banquet / classroom / conference ——
  {
    name: 'Banquet 6′ × 30″',
    category: 'table-rect',
    widthIn: 72,
    depthIn: 30,
    kind: 'rect',
    notes: '6′ × 30″ banquet / classroom table.',
  },
  {
    name: 'Banquet 8′ × 30″',
    category: 'table-rect',
    widthIn: 96,
    depthIn: 30,
    kind: 'rect',
    notes: '8′ × 30″ banquet table.',
  },
  {
    name: 'Classroom 6′ × 18″',
    category: 'table-rect',
    widthIn: 72,
    depthIn: 18,
    kind: 'rect',
    notes: '6′ × 18″ classroom / schoolroom table.',
  },
  {
    name: 'Classroom 8′ × 18″',
    category: 'table-rect',
    widthIn: 96,
    depthIn: 18,
    kind: 'rect',
    notes: '8′ × 18″ classroom / schoolroom table.',
  },
  {
    name: 'Banquet 6′ × 18″',
    category: 'table-rect',
    widthIn: 72,
    depthIn: 18,
    kind: 'rect',
    notes: '6′ × 18″ narrow banquet / buffet runner table.',
  },
  {
    name: 'Banquet 8′ × 18″',
    category: 'table-rect',
    widthIn: 96,
    depthIn: 18,
    kind: 'rect',
    notes: '8′ × 18″ narrow banquet / buffet runner table.',
  },
  {
    name: 'Conference 8′ × 42″',
    category: 'table-rect',
    widthIn: 96,
    depthIn: 42,
    kind: 'rect',
    notes: '8′ conference / boardroom table.',
  },
  {
    name: 'Conference 10′ × 48″',
    category: 'table-rect',
    widthIn: 120,
    depthIn: 48,
    kind: 'rect',
    notes: '10′ conference / boardroom table.',
  },
  {
    name: 'Square Cocktail 36″',
    category: 'table-rect',
    widthIn: 36,
    depthIn: 36,
    kind: 'rect',
    notes: '36″ square cocktail / cabaret table.',
  },
  // —— Buffet ——
  {
    name: 'Half-Round 60″',
    category: 'table-round',
    widthIn: 60,
    depthIn: 30,
    kind: 'half-round',
    notes: '60″ half-round for buffets and registration.',
  },
  {
    name: 'Serpentine 8′',
    category: 'table-round',
    widthIn: 96,
    depthIn: 30,
    kind: 'half-round',
    notes: 'Serpentine / crescent buffet section (plan as half-round span).',
  },
];

function hospitalityIcon(spec: HospitalitySpec): CatalogIcon {
  const w = spec.widthIn * UNITS_PER_INCH;
  const h = spec.depthIn * UNITS_PER_INCH;
  if (spec.kind === 'chair') return chairIcon(w, h);
  if (spec.kind === 'round') return circleIcon(Math.max(w, h));
  if (spec.kind === 'half-round') return halfRoundIcon(Math.max(w, h * 2));
  return rectIcon(w, h);
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
  const view = classify(product.name).view;
  // Elevations belong in the inventory tab, not the Place palette / seating
  // seed. Keep plan drawings in the starter pack; skip FV/SV/RV catalogue rows.
  if (view !== 'plan') {
    skipped++;
    continue;
  }
  const item: InventoryItem = {
    id: `li_seed_${shortHash(product.id)}`,
    name: product.name,
    department: DEPARTMENT_FOR[category] ?? 'Equipment',
    category,
    view,
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

let hospitalityAdded = 0;
const existingNames = new Set(inventory.items.map((item) => normaliseName(item.name)));
for (const spec of HOSPITALITY_FURNITURE) {
  if (existingNames.has(normaliseName(spec.name))) continue;
  const icon = hospitalityIcon(spec);
  const width = spec.widthIn * UNITS_PER_INCH;
  const height = spec.depthIn * UNITS_PER_INCH;
  const item: InventoryItem = {
    id: `li_hosp_${shortHash(spec.name)}`,
    name: spec.name,
    department: 'Furniture',
    category: spec.category,
    view: 'plan',
    width,
    height,
    sizeSource: 'symbol',
    timesSeen: 1,
    legacyTimesSeen: 1,
    provenanceIds: [],
    peakQuantity: 1,
    notes: `${spec.notes} Standard hospitality footprint.`,
    tracedIcon: {
      paths: icon.paths.map((path) => ({
        points: [...path.points],
        closed: path.closed,
      })),
      width: icon.width,
      height: icon.height,
    },
    mappedBy: 'user',
    mapReason: 'bundled hospitality furniture silhouette',
    addedAt,
  };
  void CATEGORY_LAYER[spec.category];
  inventory.items.push(item);
  existingNames.add(normaliseName(spec.name));
  hospitalityAdded++;
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

console.log(
  `wrote ${inventory.items.length} items to ${outDir} (catalog icons ${withIcon - hospitalityAdded}, hospitality ${hospitalityAdded}, skipped ${skipped})`,
);

// Venue doors live in the harvested symbol pack, not the equipment catalog.
// Re-attach them after every rebuild so Create → Door / Place gear keep real
// swing marks instead of falling back to boxes.
const assetDir = join(outDir, 'inventory-assets');
if (existsSync(assetDir)) {
  const pack = readdirSync(assetDir).find((name) => /card-party-symbols-.*\.rv4$/i.test(name));
  if (pack) {
    execFileSync(
      'npx',
      [
        'tsx',
        'tools/harvest-plan-symbols.ts',
        '--plan',
        join(assetDir, pack),
        '--inventory',
        join(outDir, INVENTORY_FILENAME),
        '--only',
        'Door',
      ],
      { stdio: 'inherit' },
    );
  }
}

// Harvest writes absolute symbolPath for the build machine — strip those so
// Windows (and other installs) resolve via portable symbolAsset.relativePath.
{
  const inventoryPath = join(outDir, INVENTORY_FILENAME);
  const packed = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
    items: Array<{
      symbolPath?: string;
      symbolAsset?: { relativePath?: string; sourcePath?: string };
    }>;
  };
  let stripped = 0;
  for (const item of packed.items) {
    if (!item.symbolPath) continue;
    const absolute =
      item.symbolPath.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(item.symbolPath) ||
      item.symbolPath.includes('\\Users\\') ||
      item.symbolPath.includes('/Users/');
    if (!absolute) continue;
    if (item.symbolAsset?.relativePath) {
      item.symbolPath = item.symbolAsset.relativePath.replace(/\\/g, '/');
    } else {
      delete item.symbolPath;
    }
    if (item.symbolAsset?.sourcePath) delete item.symbolAsset.sourcePath;
    stripped++;
  }
  writeFileSync(inventoryPath, `${JSON.stringify(packed, null, 2)}\n`, 'utf8');
  if (stripped) console.log(`stripped ${stripped} absolute symbol paths for portable installs`);
}