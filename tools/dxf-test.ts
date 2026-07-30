/**
 * Checks the DXF export across the corpus.
 *
 * The value of this export is structural, not visual: repeated gear has to
 * arrive as one block plus many insertions, because that is what lets someone
 * swap a 2D chair for a 3D chair once instead of a hundred times. A file that
 * merely *looks* right when opened, but exploded every symbol, would fail
 * silently at exactly the moment it mattered.
 *
 * So these assert the structure, the units, and that every insertion resolves
 * to a block that exists.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

import { loadBuffer } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { toDxf } from '../src/format/dxf.js';

const DIR = process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data';
const LIMIT = Number(process.argv[3] ?? 20);

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

/** Reads back the group-code stream, which is all a DXF is. */
function parse(text: string): Array<[number, string]> {
  const lines = text.split(/\r\n/);
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}

const plans = readdirSync(DIR)
  .filter((f) => extname(f).toLowerCase() === '.rv4' && !f.startsWith('._'))
  .sort()
  .slice(0, LIMIT);

let exercised = 0;
let totalBlocks = 0;
let totalInserts = 0;
const problems: string[] = [];

for (const name of plans) {
  const path = join(DIR, name);
  let doc;
  try {
    doc = loadBuffer(readFileSync(path), path).document;
  } catch {
    continue;
  }

  const result = toDxf(doc, buildScene(doc));
  const pairs = parse(result.text);
  exercised++;
  totalBlocks += result.blocks;
  totalInserts += result.inserts;

  // Sections must open and close in order, and the file must terminate.
  const markers = pairs.filter(([c]) => c === 0).map(([, v]) => v);
  if (markers.filter((m) => m === 'SECTION').length !== 4) problems.push(`${name}: section count`);
  if (markers.filter((m) => m === 'ENDSEC').length !== 4) problems.push(`${name}: endsec count`);
  if (markers[markers.length - 1] !== 'EOF') problems.push(`${name}: no EOF`);

  // Blocks must be balanced.
  const opens = markers.filter((m) => m === 'BLOCK').length;
  const closes = markers.filter((m) => m === 'ENDBLK').length;
  if (opens !== closes) problems.push(`${name}: ${opens} BLOCK vs ${closes} ENDBLK`);

  // Every polyline must be terminated, or a reader runs past its own data.
  const polylines = markers.filter((m) => m === 'POLYLINE').length;
  const seqends = markers.filter((m) => m === 'SEQEND').length;
  if (polylines !== seqends) problems.push(`${name}: ${polylines} POLYLINE vs ${seqends} SEQEND`);

  // Collect defined block names, then confirm every INSERT names one of them.
  const defined = new Set<string>();
  const referenced: string[] = [];
  let inBlockHeader = false;
  let inInsert = false;
  for (const [code, value] of pairs) {
    if (code === 0) {
      inBlockHeader = value === 'BLOCK';
      inInsert = value === 'INSERT';
      continue;
    }
    if (code === 2 && inBlockHeader) {
      defined.add(value);
      inBlockHeader = false;
    } else if (code === 2 && inInsert) {
      referenced.push(value);
      inInsert = false;
    }
  }
  const dangling = referenced.filter((r) => !defined.has(r));
  if (dangling.length > 0) problems.push(`${name}: ${dangling.length} inserts with no block`);
  if (referenced.length !== result.inserts) problems.push(`${name}: insert count disagrees`);

  // Inches, declared. A ballroom arriving as millimetres is the classic failure.
  const units = pairs.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
  if (units === -1 || pairs[units + 1]?.[1] !== '1') problems.push(`${name}: units not inches`);
}

check(`DXF structure is sound across ${exercised} plans`, problems.length === 0);
for (const p of problems.slice(0, 8)) console.error(`        ${p}`);

// The whole point: repeated gear collapses to a handful of reusable symbols.
check('repeated gear exports as far fewer blocks than placements', totalInserts > totalBlocks * 3);

console.log(
  `${checks - failures}/${checks} checks passed  (${totalBlocks} blocks, ${totalInserts} placements across ${exercised} plans)`,
);
if (failures > 0) process.exit(1);
