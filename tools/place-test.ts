/**
 * Proves gear placed on a plan survives a save.
 *
 * Places several real lines from the Card Party gear list onto a copy of a
 * plan, saves, reopens, and checks each one is present, named correctly, sized
 * as the description implies, and that the file still parses cleanly.
 *
 *   npx tsx tools/place-test.ts
 */

import { copyFileSync, readFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { loadBuffer } from '../src/format/index.js';
import { indexDocument } from '../src/format/edit.js';
import { placeGear, parseDimensions } from '../src/format/place.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { buildScene } from '../src/format/scene.js';
import type { RVNode } from '../src/format/index.js';

const SOURCE = process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';
const UNITS_PER_FOOT = 120;

/** Real lines from the Card Party list, spanning matched and synthesized. */
const GEAR = [
  { description: 'Round 66"', expect: 'matched' },
  { description: "Intellistage 4' x 4' Stage Deck", expect: 'synthesized', width: 4, height: 4 },
  { description: "20.5\" x 8' Box Truss - Black", expect: 'synthesized' },
  { description: '65" Samsung Standard TV', expect: 'synthesized' },
  { description: 'Chauvet Freedom Flex H4 IP Fixture', expect: 'synthesized' },
];

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

// --- dimension parsing, independent of any file -----------------------------
const dims = [
  ["Intellistage 4' x 4' Stage Deck", 4 * UNITS_PER_FOOT, 4 * UNITS_PER_FOOT],
  ["Frame Bottom - 11'X20'", 11 * UNITS_PER_FOOT, 20 * UNITS_PER_FOOT],
  ['Gray Velour Drape w/Pockets - 16\' x 14.5\'', 16 * UNITS_PER_FOOT, 14.5 * UNITS_PER_FOOT],
  ["6' x 30\"", 6 * UNITS_PER_FOOT, 30 * 10],
] as const;

for (const [text, width, height] of dims) {
  const d = parseDimensions(text);
  check(
    `parses "${text}"`,
    Math.abs(d.width - width) < 1 && Math.abs(d.height - height) < 1,
    `got ${d.width}x${d.height}, wanted ${width}x${height}`,
  );
}

check('leaves a cable unsized', parseDimensions("XLR - 50'").source === 'default');
check('leaves a jumper unsized', parseDimensions('Cat 6 Shielded - Jumper').source === 'default');

// --- placing onto a real plan ----------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'groundplan-place-'));
const work = join(dir, basename(SOURCE));
copyFileSync(SOURCE, work);
const original = readFileSync(work);

const doc = loadBuffer(original, work).document;
check('plan is editable to begin with', roundTrip(doc).identical);

const before = buildScene(doc).counts['RVShape'] ?? 0;
const placed: Array<{ description: string; method?: string }> = [];

let x = 0;
for (const item of GEAR) {
  const index = indexDocument(doc);
  const result = placeGear(doc, index, item.description, x, 0);
  check(`places ${item.description}`, result.ok, result.reason);
  if (result.ok) placed.push({ description: item.description, method: result.method });
  if (item.expect === 'matched') check(`  matched a real shape`, result.method === 'matched', result.method);
  x += 10 * UNITS_PER_FOOT;
}

const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, work);

check('saved file parses cleanly', reread.document.warnings.length === 0, reread.document.warnings[0]?.message);
check('saved file is still editable', roundTrip(reread.document).identical);

const after = buildScene(reread.document).counts['RVShape'] ?? 0;
check(`added ${placed.length} shapes`, after === before + placed.length, `${after} vs ${before + placed.length}`);

// Every synthesized item should be findable by name in the reopened file.
const names = new Set<string>();
const seen = new Set<RVNode>();
const visit = (n: RVNode) => {
  if (seen.has(n)) return;
  seen.add(n);
  for (const l of n.labels) names.add(l);
  for (const c of n.children) visit(c);
};
for (const r of reread.document.roots) visit(r);

for (const item of placed) {
  if (item.method !== 'synthesized') continue;
  check(`  "${item.description}" survives the save`, names.has(item.description));
}

// Footprint check on a known size.
const deck = [...seen].find((n) => n.cls === 'RVShape' && n.labels.includes("Intellistage 4' x 4' Stage Deck"));
if (deck) {
  const w = deck.bounds.right - deck.bounds.left;
  const h = deck.bounds.bottom - deck.bounds.top;
  check(
    '  stage deck is 4ft x 4ft on the plan',
    Math.abs(w - 4 * UNITS_PER_FOOT) < 2 && Math.abs(h - 4 * UNITS_PER_FOOT) < 2,
    `${(w / UNITS_PER_FOOT).toFixed(1)}ft x ${(h / UNITS_PER_FOOT).toFixed(1)}ft`,
  );
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

unlinkSync(work);
process.exit(failed ? 1 : 0);
