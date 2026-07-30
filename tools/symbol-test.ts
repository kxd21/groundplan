/**
 * Imports a symbol from one file into another and checks it survives a save.
 */
import { copyFileSync, readFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadBuffer, walk } from '../src/format/index.js';
import { indexDocument } from '../src/format/edit.js';
import { listSymbols, importSymbol } from '../src/format/symbol.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { buildScene } from '../src/format/scene.js';

const DEST = '/Volumes/Prince/Roomviewer/Data/1 BAC - Thames Room (Drape Booths).rv4';
const SRC = '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';
const FOOT = 120;
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

const dir = mkdtempSync(join(tmpdir(), 'gp-sym-'));
const work = join(dir, basename(DEST));
copyFileSync(DEST, work);
const original = readFileSync(work);

const source = loadBuffer(readFileSync(SRC), SRC).document;
const symbols = listSymbols(source);
check('lists symbols from a plan', symbols.length >= 3, `${symbols.length} found`);
const round = symbols.find((s) => /Round 66/.test(s.name));
check('a round table is among them', !!round);
check('with a real footprint', !!round && Math.abs(round.width - 660) < 5, `${round?.width}`);

const doc = loadBuffer(original, work).document;
check('destination has no Round 66 yet', !buildScene(doc).inventory.some((i) => /Round 66/.test(i.name)));

const index = indexDocument(doc);
const result = importSymbol(doc, index, source, 'Round 66"', 0, 0);
check('imports the symbol', result.ok, result.reason);

const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, work);
check('saved plan reparses cleanly', reread.document.warnings.length === 0, reread.document.warnings[0]?.message);
check('saved plan stays editable', roundTrip(reread.document).identical);

const scene = buildScene(reread.document);
const item = scene.inventory.find((i) => /Round 66/.test(i.name));
check('the imported symbol is in the inventory', !!item, JSON.stringify(scene.inventory.map((i) => i.name)));

// It must arrive as real geometry, not an empty placeholder.
let outline = 0;
for (const n of walk(reread.document)) {
  if (n.cls === 'RVShape' && n.labels.some((l) => /Round 66/.test(l))) {
    const g = n.children.find((c) => c.cls === 'RVGeometry');
    for (const seg of g?.children ?? []) outline += seg.points.length;
  }
}
check('it brought its outline with it', outline > 50, `${outline} points`);

let failed = 0;
for (const [n, ok, d] of checks) { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}${!ok && d ? ` — ${d}` : ''}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
unlinkSync(work);
void FOOT;
process.exit(failed ? 1 : 0);
