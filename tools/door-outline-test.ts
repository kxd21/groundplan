import { readFileSync } from 'node:fs';
import { createBlankPlan } from '../src/format/blank.js';
import { indexDocument } from '../src/format/edit.js';
import { placeGear } from '../src/format/place.js';
import { buildScene } from '../src/format/scene.js';
import { loadBuffer } from '../src/format/index.js';
import { importSymbol } from '../src/format/symbol.js';
import { classify } from '../src/inventory/classify.js';
import { doorIcon, doorOutline, doorSwingFromName } from '../src/format/synthesize.js';

const F = 120;
let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

check('Door classifies as door', classify('Door - Double (Out)').category === 'door');
check('Single door classifies as door', classify('Door - Single (In) Left Swing').category === 'door');
check('barn door stays not-drawn', classify('Source Four barn door').category === 'not-drawn');

const swing = doorSwingFromName('Door - Single (In) Left Swing');
check('in swing', swing.out === false);
check('left hand', swing.hand === 'L');
check('double leaves', doorSwingFromName('Door - Double (Out)').leaves === 2);

const outline = doorOutline(6 * F, 4 * F, doorSwingFromName('Door - Double (Out)'));
check('door outline has jamb+leaves+arcs', outline.length >= 5, `got ${outline.length}`);

const leftIcon = doorIcon(3 * F, 3.2 * F, doorSwingFromName('Door - Single (In) Left Swing'));
check('left swing icon is not a lone box', leftIcon.paths.length >= 3, `paths=${leftIcon.paths.length}`);

const blank = createBlankPlan();
check('blank plan', !!blank.ok && !!blank.file, blank.reason);
const doc = loadBuffer(blank.file!, 'New.rv4').document;
const index = indexDocument(doc);
const placed = placeGear(doc, index, 'Door - Double (Out)', 20 * F, 20 * F, {
  width: 6 * F,
  height: 4 * F,
});
check('placeGear synthesizes door', !!placed.ok && placed.method === 'synthesized', String(placed.method));
const scene = buildScene(doc);
const doorPrims = scene.primitives.filter((p) => /door/i.test(p.owner || ''));
check('synthesized door is not a lone box', doorPrims.length >= 3, `prims=${doorPrims.length}`);

const leftPlaced = placeGear(doc, indexDocument(doc), 'Door - Single (In) Left Swing', 40 * F, 20 * F, {
  width: 3 * F,
  height: 3.2 * F,
});
check('left swing synthesizes', !!leftPlaced.ok && leftPlaced.method === 'synthesized');
const leftPrims = buildScene(doc).primitives.filter((p) => /Left Swing/i.test(p.owner || ''));
check('left swing has jamb+leaf+arc', leftPrims.length >= 3, `prims=${leftPrims.length}`);

const source = loadBuffer(
  readFileSync('resources/starter-inventory/inventory-assets/card-party-symbols-5e44eafd4da0a4c2.rv4'),
  'sym',
).document;
const blank2 = createBlankPlan();
const doc2 = loadBuffer(blank2.file!, 'New2.rv4').document;
const idx2 = indexDocument(doc2);
const imported = importSymbol(doc2, idx2, source, 'Door - Double (Out)', 10 * F, 10 * F);
check('importSymbol door ok', !!imported.ok, imported.ok ? '' : String((imported as { reason?: string }).reason));
const scene2 = buildScene(doc2);
const importedPrims = scene2.primitives.filter((p) => /door/i.test(p.owner || ''));
check(
  'imported door keeps multi-path swing',
  importedPrims.length >= 3,
  `prims=${importedPrims.length}`,
);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
