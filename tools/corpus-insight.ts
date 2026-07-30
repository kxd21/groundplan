/**
 * What the plan corpus says about how these shows get built.
 *
 * Feature decisions should come from the real work, not from guesses about it,
 * so this walks every plan and reports the shapes that actually get placed, how
 * rooms are sized, how often a venue or a show gets reused, and what people
 * write on the drawings.
 *
 *   npx tsx tools/corpus-insight.ts "/Volumes/Prince/Roomviewer/Data"
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { loadBuffer, walk } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';

const DIR = process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data';
const UNITS_PER_FOOT = 120;

const files = readdirSync(DIR).filter((f) => !f.startsWith('._') && ['.rv4', '.rs4'].includes(extname(f).toLowerCase()));

const itemCounts = new Map<string, number>();
const itemPlans = new Map<string, number>();
const roomSizes: Array<{ name: string; w: number; h: number; area: number }> = [];
const labels = new Map<string, number>();
const byYear = new Map<number, number>();
const objectCounts: number[] = [];
let withDimensions = 0;
let withLabels = 0;
let parsed = 0;

/** `Show v2`, `Show (3)`, `Show REV B` — the same job drawn more than once. */
function showKey(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\s*[-_(]?\s*\b(v|ver|version|rev|revision)\s*\.?\s*\d+[a-z]?\b\)?/gi, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s*-\s*copy\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const shows = new Map<string, string[]>();

for (const name of files) {
  const path = join(DIR, name);
  let loaded;
  try {
    loaded = loadBuffer(readFileSync(path), path);
  } catch {
    continue;
  }
  parsed++;

  try {
    byYear.set(statSync(path).mtime.getFullYear(), (byYear.get(statSync(path).mtime.getFullYear()) ?? 0) + 1);
  } catch {
    /* ignore */
  }

  const key = showKey(name);
  shows.set(key, [...(shows.get(key) ?? []), name]);

  const scene = buildScene(loaded.document);
  objectCounts.push(scene.primitives.length);

  const seenHere = new Set<string>();
  for (const item of scene.inventory) {
    itemCounts.set(item.name, (itemCounts.get(item.name) ?? 0) + item.count);
    seenHere.add(item.name);
  }
  for (const n of seenHere) itemPlans.set(n, (itemPlans.get(n) ?? 0) + 1);

  const e = scene.roomExtent;
  if (e) {
    const w = (e.maxX - e.minX) / UNITS_PER_FOOT;
    const h = (e.maxY - e.minY) / UNITS_PER_FOOT;
    if (w > 5 && h > 5 && w < 2000 && h < 2000) roomSizes.push({ name, w, h, area: w * h });
  }

  let hasDim = false;
  let hasLabel = false;
  for (const node of walk(loaded.document)) {
    if (node.cls === 'RVDimensionLine') hasDim = true;
    if (node.cls === 'RVLabel') {
      hasLabel = true;
      const text = node.labels.find((l) => !/^(Arial|Times|Courier|Helvetica|Tahoma|Verdana|Symbol)/i.test(l));
      if (text && text.length > 1) labels.set(text, (labels.get(text) ?? 0) + 1);
    }
  }
  if (hasDim) withDimensions++;
  if (hasLabel) withLabels++;
}

const pct = (n: number) => `${((n / parsed) * 100).toFixed(0)}%`;

console.log(`plans analysed: ${parsed}\n`);

console.log('most-placed items (total placed / plans they appear in)');
for (const [name, count] of [...itemCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${String(count).padStart(7)}  in ${String(itemPlans.get(name) ?? 0).padStart(4)} plans  ${name}`);
}

console.log('\nroom sizes');
roomSizes.sort((a, b) => a.area - b.area);
const median = roomSizes[Math.floor(roomSizes.length / 2)];
console.log(`  smallest  ${roomSizes[0]?.w.toFixed(0)}ft x ${roomSizes[0]?.h.toFixed(0)}ft`);
console.log(`  median    ${median?.w.toFixed(0)}ft x ${median?.h.toFixed(0)}ft`);
console.log(`  largest   ${roomSizes.at(-1)?.w.toFixed(0)}ft x ${roomSizes.at(-1)?.h.toFixed(0)}ft`);

console.log('\nannotation');
console.log(`  plans with dimension lines  ${withDimensions} (${pct(withDimensions)})`);
console.log(`  plans with text labels      ${withLabels} (${pct(withLabels)})`);

console.log('\nmost-repeated label text');
for (const [text, n] of [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${String(n).padStart(5)}  ${JSON.stringify(text.slice(0, 58))}`);
}

const revised = [...shows.entries()].filter(([, list]) => list.length > 1);
console.log(`\nshows drawn more than once: ${revised.length} of ${shows.size} distinct shows`);
for (const [, list] of revised.sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
  console.log(`  ${list.length} versions  ${basename(list[0]).slice(0, 68)}`);
}

console.log('\nplans per year');
for (const [year, n] of [...byYear.entries()].sort()) {
  console.log(`  ${year}  ${'█'.repeat(Math.ceil(n / 8))} ${n}`);
}

objectCounts.sort((a, b) => a - b);
console.log(`\nobjects per plan: median ${objectCounts[Math.floor(objectCounts.length / 2)]}, largest ${objectCounts.at(-1)}`);
