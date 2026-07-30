/**
 * Verifies annotation creation and angled seating blocks — the pieces needed to
 * rebuild a show like the Card Party East arena plan.
 */
import { copyFileSync, readFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadBuffer, walk } from '../src/format/index.js';
import { indexDocument } from '../src/format/edit.js';
import { createLabel, createDimension, formatDistance } from '../src/format/annotate.js';
import { addSeating } from '../src/format/seating.js';
import { serializeArchive, roundTrip, packContainer } from '../src/format/write.js';
import { buildScene } from '../src/format/scene.js';

const SOURCE = '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';
const FOOT = 120;
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

const dir = mkdtempSync(join(tmpdir(), 'gp-annot-'));
const work = join(dir, basename(SOURCE));
copyFileSync(SOURCE, work);
const original = readFileSync(work);

check('formats 22ft', formatDistance(22 * FOOT) === '22 ft  0 in', formatDistance(22 * FOOT));
check('formats 5ft 3in', formatDistance(5 * FOOT + 3 * 10) === '5 ft  3 in', formatDistance(5 * FOOT + 3 * 10));

const doc = loadBuffer(original, work).document;
let index = indexDocument(doc);

const label = createLabel(doc, index, "Stage 8' X 42' X 24\"", 0, -20 * FOOT);
check('creates a label', label.ok, label.reason);

index = indexDocument(doc);
const multi = createLabel(doc, index, 'SoloFrame\n1500 on Case', 10 * FOOT, -20 * FOOT);
check('creates a multi-line label', multi.ok, multi.reason);

index = indexDocument(doc);
const dim = createDimension(doc, index, -10 * FOOT, 0, 12 * FOOT, 0);
check('creates a dimension', dim.ok, dim.reason);
check('dimension measures 22ft', dim.text === '22 ft  0 in', dim.text);

index = indexDocument(doc);
const angled = addSeating(doc, index, {
  kind: 'theatre', x: 0, y: 30 * FOOT, chair: 'Standard 18"x18"', rows: 4, perRow: 6, angle: 30,
});
check('creates an angled block', angled.ok, angled.reason);
check('placed 24 chairs', angled.placed === 24, String(angled.placed));

const saved = packContainer(original, serializeArchive(doc));
const reread = loadBuffer(saved, work);
check('saved plan reparses cleanly', reread.document.warnings.length === 0, reread.document.warnings[0]?.message);
check('saved plan stays editable', roundTrip(reread.document).identical);

const texts = new Set<string>();
for (const n of walk(reread.document)) {
  for (const l of n.labels) texts.add(l);
}

/*
 * The block's angle shows in where the chairs sit, not in the angle field:
 * a cloned chair inherits the template's own rotation, so +30 degrees lands
 * wherever that template already pointed. Measuring the row direction is the
 * honest check.
 */
const block = (angled.created ?? [])
  .map((id) => [...walk(doc)].find((n) => n.id === id))
  .filter((n): n is NonNullable<typeof n> => !!n && n.cls === 'RVShape' && !!n.points[0])
  .map((n) => n.points[0]!);

let rowAngle = NaN;
if (block.length >= 6) {
  // The first six chairs are one row; the line through them is the block angle.
  const a = block[0];
  const b = block[5];
  rowAngle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}
check('label text survives the save', texts.has("Stage 8' X 42' X 24\""));
check('multi-line label survives', [...texts].some((t) => t.includes('SoloFrame') && /[\r\n]/.test(t)));
check('dimension text survives', texts.has('22 ft  0 in'));
check('block holds 24 chairs', block.length === 24, String(block.length));
check('rows run at 30°', Math.abs(rowAngle - 30) < 1, `${rowAngle.toFixed(1)}°`);

const scene = buildScene(reread.document);
check('all annotation renders', scene.primitives.length > 0);

let failed = 0;
for (const [n, ok, d] of checks) { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}${!ok && d ? ` — ${d}` : ''}`); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
unlinkSync(work);
process.exit(failed ? 1 : 0);
