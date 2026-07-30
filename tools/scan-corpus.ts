/**
 * Parses every Room Viewer file under a root directory and reports coverage.
 *
 * This is the parser's regression harness: the layouts in `src/format/rv.ts`
 * were derived from this corpus, so a drop in the "clean" count means a layout
 * assumption broke.
 *
 *   npm run scan -- "/Volumes/Prince/Roomviewer"
 */

import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

import { loadFile, classHistogram, geometryExtent } from '../src/format/index.js';

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
console.log(`scanning ${files.length} files under ${ROOT}\n`);

let clean = 0;
let warned = 0;
let failed = 0;
let noGeometry = 0;
const classTotals: Record<string, number> = {};
const warningKinds: Record<string, number> = {};
const failures: Array<{ file: string; error: string }> = [];
const byExtension: Record<string, { n: number; clean: number; objects: number }> = {};

for (const file of files) {
  const ext = extname(file).toLowerCase();
  byExtension[ext] ??= { n: 0, clean: 0, objects: 0 };
  byExtension[ext].n++;

  try {
    const loaded = loadFile(file);
    const hist = classHistogram(loaded.document);
    let objects = 0;
    for (const [cls, n] of Object.entries(hist)) {
      classTotals[cls] = (classTotals[cls] ?? 0) + n;
      objects += n;
    }
    byExtension[ext].objects += objects;

    const extent = geometryExtent(loaded.document);
    if (!extent) noGeometry++;

    const warnings = loaded.document.warnings;
    if (warnings.length === 0) {
      clean++;
      byExtension[ext].clean++;
    } else {
      warned++;
      for (const w of warnings) {
        const key = w.message.replace(/\d+/g, 'N');
        warningKinds[key] = (warningKinds[key] ?? 0) + 1;
      }
      if (VERBOSE) {
        console.log(`WARN ${file}`);
        for (const w of warnings.slice(0, 3)) console.log(`      ${w.message}`);
      }
    }
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ file, error: msg });
    if (VERBOSE) console.log(`FAIL ${file}\n      ${msg}`);
  }
}

const pct = (n: number) => ((n / files.length) * 100).toFixed(1).padStart(5) + '%';

console.log('results');
console.log(`  clean          ${String(clean).padStart(5)}  ${pct(clean)}`);
console.log(`  with warnings  ${String(warned).padStart(5)}  ${pct(warned)}`);
console.log(`  failed         ${String(failed).padStart(5)}  ${pct(failed)}`);
console.log(`  no geometry    ${String(noGeometry).padStart(5)}  ${pct(noGeometry)}`);

console.log('\nby extension');
for (const [ext, s] of Object.entries(byExtension).sort()) {
  console.log(
    `  ${ext.padEnd(6)} ${String(s.n).padStart(5)} files  ${String(s.clean).padStart(5)} clean  ${String(s.objects).padStart(7)} objects`,
  );
}

console.log('\nobjects decoded by class');
for (const [cls, n] of Object.entries(classTotals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(8)}  ${cls}`);
}

if (Object.keys(warningKinds).length) {
  console.log('\nwarning kinds');
  for (const [k, n] of Object.entries(warningKinds).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
}

if (failures.length) {
  console.log('\nfailures');
  for (const f of failures.slice(0, 20)) console.log(`  ${f.error}\n    ${f.file}`);
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
}
