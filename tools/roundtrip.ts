/**
 * Round-trips every file: parse, re-serialize, compare bytes.
 *
 * This is the gate for editing. A file that does not reproduce itself exactly
 * is one whose structure the parser does not fully understand, and saving it
 * could lose data — so the app opens those read-only.
 *
 *   npx tsx tools/roundtrip.ts "/Volumes/Prince/Roomviewer" [--verbose]
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

import { loadFile } from '../src/format/index.js';
import { roundTrip } from '../src/format/write.js';

const ROOT = process.argv[2] ?? '/Volumes/Prince/Roomviewer';
const VERBOSE = process.argv.includes('--verbose');
const EXTENSIONS = new Set(['.rv4', '.rs4', '.se4', '.ds4', '.add', '.stk', '.lib', '.rsd']);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (!entry.name.startsWith('._') && EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(p);
  }
  return out;
}

const files = collect(ROOT).sort();
console.log(`round-tripping ${files.length} files\n`);

let identical = 0;
let differs = 0;
let failed = 0;
const reasons: Record<string, number> = {};
const examples: string[] = [];
const byExt: Record<string, { n: number; ok: number }> = {};

for (const file of files) {
  const ext = extname(file).toLowerCase();
  byExt[ext] ??= { n: 0, ok: 0 };
  byExt[ext].n++;

  try {
    const loaded = loadFile(file);
    const result = roundTrip(loaded.document);

    if (result.identical) {
      identical++;
      byExt[ext].ok++;
      continue;
    }

    if (result.error) {
      failed++;
      const key = result.error.replace(/\d+/g, 'N');
      reasons[key] = (reasons[key] ?? 0) + 1;
      if (VERBOSE && examples.length < 10) examples.push(`${file}\n    ${result.error}`);
    } else {
      differs++;
      const src = readFileSync(file);
      const key = `bytes differ (source ${src.length > result.written.length ? 'longer' : 'shorter/equal'})`;
      reasons[key] = (reasons[key] ?? 0) + 1;
      if (VERBOSE && examples.length < 10) {
        examples.push(`${file}\n    diverges at byte ${result.divergesAt}, wrote ${result.written.length}`);
      }
    }
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    const key = msg.replace(/\d+/g, 'N');
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
}

const pct = (n: number) => ((n / files.length) * 100).toFixed(1).padStart(5) + '%';
console.log('results');
console.log(`  byte-identical  ${String(identical).padStart(5)}  ${pct(identical)}   <- editable`);
console.log(`  differs         ${String(differs).padStart(5)}  ${pct(differs)}`);
console.log(`  errored         ${String(failed).padStart(5)}  ${pct(failed)}`);

console.log('\nby extension');
for (const [ext, s] of Object.entries(byExt).sort()) {
  console.log(`  ${ext.padEnd(6)} ${String(s.ok).padStart(5)} / ${String(s.n).padStart(5)} identical`);
}

if (Object.keys(reasons).length) {
  console.log('\nreasons');
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
}

if (examples.length) {
  console.log('\nexamples');
  for (const e of examples) console.log(`  ${e}`);
}
