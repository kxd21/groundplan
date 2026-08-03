/**
 * A placed item is one object to a person, several nodes to the file.
 *
 * Selecting what was just created must collapse the internal geometry back to
 * the shapes a click would select, so placing one chair selects one item and a
 * seating block selects the chairs — not their thousands of outline segments.
 *
 *   npx tsx tools/selection-test.ts
 */

import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { loadBuffer } from '../src/format/index.js';
import { indexDocument } from '../src/format/edit.js';
import { placeGear } from '../src/format/place.js';
import { buildScene } from '../src/format/scene.js';
import { selectableIds } from '../src/renderer/src/selection.js';
import { fixturePlanBuffer } from './test-fixture.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

const F = UNITS_PER_FOOT;

console.log('selecting what was created\n');

const fixture = fixturePlanBuffer();
const doc = loadBuffer(fixture, 'fixture.rv4').document;
const index = indexDocument(doc);

// Cloning the catalogue shape draws one shape from several nodes: the RVShape,
// its RVGeometry and the outline segment.
const placed = placeGear(doc, index, 'Fixture Table', 20 * F, 20 * F);
check('a gear item is placed', placed.ok, placed.reason);
check('and reports more than one created node', (placed.created?.length ?? 0) > 1, `${placed.created?.length} nodes`);

const scene = buildScene(doc);
const selection = selectableIds(placed.created ?? [], scene);
check('the selection collapses to a single object', selection.length === 1, `got ${selection.length}: ${selection.join(', ')}`);
check(
  'and that object is one a click resolves to',
  selection.length === 1 && scene.primitives.some((p) => p.selectId === selection[0]),
  `${selection[0]}`,
);

// A second placement: two placed shapes must select as two, never their parts.
const doc2 = loadBuffer(fixture, 'fixture.rv4').document;
const idx2 = indexDocument(doc2);
const a = placeGear(doc2, idx2, 'Fixture Table', 10 * F, 10 * F);
const b = placeGear(doc2, indexDocument(doc2), 'Fixture Table', 30 * F, 30 * F);
const both = [...(a.created ?? []), ...(b.created ?? [])];
const scene2 = buildScene(doc2);
const selection2 = selectableIds(both, scene2);
check('two placements select as two objects', selection2.length === 2, `got ${selection2.length}`);
check('with no duplicate ids', new Set(selection2).size === selection2.length);

// Degenerate inputs.
check('an empty list stays empty', selectableIds([], scene).length === 0);
check(
  'ids with no drawn primitive fall back rather than vanish',
  selectableIds([999999], scene).length === 1,
);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
