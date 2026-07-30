/**
 * Adds researched equipment to the catalog.
 *
 * Every dimension here came from a manufacturer datasheet or specification
 * page, not from estimation. Where a figure could not be found it is left out
 * rather than guessed — a catalog that invents a footprint is worse than one
 * that admits it does not know, because a plan drawn against a wrong dimension
 * fails at load-in rather than on screen.
 *
 * Items with no published footprint still get an icon from the category
 * default, and are tagged so a contributor can see what needs measuring.
 *
 *   npx tsx tools/catalog-research.ts [--out catalog/products.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { generateSymbol } from '../src/catalog/symbols.js';
import type { CatalogProduct } from '../src/catalog/model.js';
import type { CatalogIcon } from '../src/catalog/icon.js';

/** Millimetres to logical units (tenths of an inch). */
const mm = (value: number): number => Math.round((value / 25.4) * 10 * 10) / 10;
/** Inches to logical units. */
const inch = (value: number): number => Math.round(value * 10 * 10) / 10;

interface Researched extends Omit<CatalogProduct, 'id' | 'name'> {
  id: string;
  name: string;
  /** Where the figures came from, recorded so they can be re-checked. */
  source: string;
}

const RESEARCHED: Researched[] = [
  {
    id: 'gp:projector:barco-udx-4k32',
    manufacturer: 'Barco',
    model: 'UDX-4K32',
    name: 'Barco UDX-4K32',
    category: 'projector',
    dimensions: { width: mm(660), depth: mm(830), height: mm(350) },
    weightLb: 202,
    specifications: {
      Brightness: '31,000 lumens',
      Resolution: '4K UHD / WQXGA',
      Light: '3-chip DLP laser phosphor',
    },
    tags: ['researched', 'large-venue'],
    source: 'Barco UDX-4K32 spec sheet — 660 x 830 x 350 mm, 92 kg',
  },
  {
    id: 'gp:moving-light:martin-mac-aura-xb',
    manufacturer: 'Martin',
    model: 'MAC Aura XB',
    name: 'Martin MAC Aura XB',
    category: 'moving-light',
    // Width across the yoke and depth at the head: the swing footprint a plan
    // has to leave clear.
    dimensions: { width: mm(302), depth: mm(163), height: mm(390) },
    weightLb: 14.4,
    specifications: { Source: '19 x 15 W RGBW LED', Type: 'Moving head wash with zoom' },
    tags: ['researched'],
    source: 'Martin MAC Aura XB specifications — 302 mm across yoke, 163 mm head depth, 6.5 kg',
  },
  {
    id: 'gp:moving-light:robe-bmfl-spot',
    manufacturer: 'Robe',
    model: 'BMFL Spot',
    name: 'Robe BMFL Spot',
    category: 'moving-light',
    dimensions: { width: mm(483), depth: mm(335), height: mm(813) },
    weightLb: 79.4,
    specifications: { Source: '1700 W', Type: 'Moving head spot' },
    tags: ['researched'],
    source: 'Robe BMFL Spot datasheet — 483 x 335 x 813 mm, 36 kg',
  },
  {
    id: 'gp:moving-light:chauvet-maverick-mk3-spot',
    manufacturer: 'Chauvet Professional',
    model: 'Maverick MK3 Spot',
    name: 'Chauvet Maverick MK3 Spot',
    category: 'moving-light',
    // Weight is published; a footprint is not. Left out rather than invented —
    // the icon falls back to the category default until someone measures one.
    weightLb: 72.9,
    specifications: { Source: '820 W LED', Colour: 'CMY' },
    tags: ['researched', 'needs-dimensions'],
    source: 'Chauvet Maverick MK3 Spot — weight published, footprint not found',
  },
  {
    id: 'gp:speaker:db-audiotechnik-v8',
    manufacturer: 'd&b audiotechnik',
    model: 'V8',
    name: 'd&b audiotechnik V8',
    category: 'speaker',
    dimensions: { width: mm(700), depth: mm(460), height: mm(310) },
    weightLb: 75,
    specifications: { Type: '3-way passive line array', Dispersion: '80 degrees', 'Max SPL': '142 dB' },
    tags: ['researched', 'line-array'],
    source: 'd&b V-Series brochure — 310 x 700 x 460 mm (H x W x D), 34 kg',
  },
  {
    id: 'gp:speaker:l-acoustics-k2',
    manufacturer: 'L-Acoustics',
    model: 'K2',
    name: 'L-Acoustics K2',
    category: 'speaker',
    dimensions: { width: mm(1350), depth: mm(520), height: mm(350) },
    weightLb: 123.2,
    specifications: { Type: '3-way active line array', 'Low frequency': 'Dual 12 inch', 'Max SPL': '147 dB' },
    tags: ['researched', 'line-array'],
    source: 'L-Acoustics K2 specifications — 1350 x 350 x 520 mm, 56 kg',
  },
  {
    id: 'gp:speaker:meyer-sound-leopard',
    manufacturer: 'Meyer Sound',
    model: 'LEOPARD',
    name: 'Meyer Sound LEOPARD',
    category: 'speaker',
    dimensions: { width: inch(26.93), depth: inch(21.66), height: inch(11.11) },
    weightLb: 75,
    specifications: { Type: 'Compact linear line array', Power: 'Self-powered' },
    tags: ['researched', 'line-array'],
    source: 'Meyer Sound LEOPARD datasheet — 26.93 x 11.11 x 21.66 in, 75 lb',
  },
  {
    id: 'gp:lighting-console:ma-grandma3-light',
    manufacturer: 'MA Lighting',
    model: 'grandMA3 light',
    name: 'MA Lighting grandMA3 light',
    category: 'lighting-console',
    dimensions: { width: mm(854), depth: mm(539), height: mm(181) },
    weightLb: 73,
    specifications: { Parameters: '16,384', Outputs: '6 x 5-pin XLR', Note: 'Folded; deeper in use' },
    tags: ['researched'],
    source: 'grandMA3 light — 854 x 539 x 181 mm folded, 33 kg',
  },
  {
    id: 'gp:mixer:digico-sd12',
    manufacturer: 'DiGiCo',
    model: 'SD12',
    name: 'DiGiCo SD12',
    category: 'mixer',
    dimensions: { width: mm(1124), depth: mm(795), height: mm(389) },
    weightLb: 96,
    specifications: { Channels: '72', Type: 'Digital mixing console' },
    tags: ['researched'],
    source: 'DiGiCo SD12 data sheet — 1124 x 795 x 389 mm, 42 kg',
  },
];

/**
 * Truss, where the section size is the published figure and the length is
 * whatever segment was ordered. Global Truss F34 measures 290 mm across.
 */
const TRUSS_LENGTHS_FT = [1.64, 3.28, 4.92, 6.56, 8.2, 9.84];
for (const feet of TRUSS_LENGTHS_FT) {
  RESEARCHED.push({
    id: `gp:truss:global-truss-f34-${String(feet).replace('.', '-')}ft`,
    manufacturer: 'Global Truss',
    model: `F34 ${feet} ft`,
    name: `Global Truss F34 12" — ${feet} ft`,
    category: 'truss',
    dimensions: { width: inch(feet * 12), depth: mm(290), height: mm(290) },
    specifications: { Section: '12 inch square', Tube: '2 inch OD', Bracing: '20 mm diagonal' },
    tags: ['researched', 'truss-segment'],
    source: 'Global Truss F34 — 290 mm (11.42 in) across, 50 mm OD main tube',
  });
}

// --- build -----------------------------------------------------------------

const outAt = process.argv.indexOf('--out');
const outPath = outAt === -1 ? 'catalog/products.json' : process.argv[outAt + 1];

const existing: CatalogProduct[] = existsSync(outPath)
  ? (JSON.parse(readFileSync(outPath, 'utf8')) as CatalogProduct[])
  : [];
const byId = new Map(existing.map((p) => [p.id, p]));

let added = 0;
let withRealDimensions = 0;
let defaulted = 0;

for (const entry of RESEARCHED) {
  const { source, ...product } = entry;

  // No drawn symbol exists for gear this shop has never had, so the icon is
  // generated from the published footprint — which is exactly what the
  // generator is for.
  const symbol = generateSymbol(product as CatalogProduct);
  const icon: CatalogIcon = {
    paths: symbol.paths,
    width: symbol.width,
    height: symbol.height,
  };

  if (product.dimensions?.width) withRealDimensions++;
  else defaulted++;

  byId.set(product.id, {
    ...(product as CatalogProduct),
    icon,
    specifications: { ...(product.specifications ?? {}), Source: source },
  } as CatalogProduct);
  added++;
}

const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

console.log(`added ${added} researched products`);
console.log(`  with published dimensions  ${withRealDimensions}`);
console.log(`  using a category default   ${defaulted} (tagged needs-dimensions)`);
console.log(`catalog now holds ${merged.length} products -> ${outPath}`);
