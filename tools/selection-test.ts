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
import { loadBuffer, walk, type RVDocument, type RVNode } from '../src/format/index.js';
import { indexDocument, moveNode } from '../src/format/edit.js';
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

function findById(doc: RVDocument, id: number): RVNode | undefined {
  for (const node of walk(doc)) {
    if (node.id === id) return node;
  }
  return undefined;
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
check(
  'and reports more than one created node',
  (placed.created?.length ?? 0) > 1,
  `${placed.created?.length} nodes`,
);

const scene = buildScene(doc);
const selection = selectableIds(placed.created ?? [], scene);
check(
  'the selection collapses to a single object',
  selection.length === 1,
  `got ${selection.length}: ${selection.join(', ')}`,
);
check(
  'and that object is one a click resolves to',
  selection.length === 1 && scene.primitives.some((p) => p.selectId === selection[0]),
  `${selection[0]}`,
);

// A second placement: two placed shapes must select as two, never their parts.
const doc2 = loadBuffer(fixture, 'fixture.rv4').document;
const a = placeGear(doc2, indexDocument(doc2), 'Fixture Table', 10 * F, 10 * F);
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
check('a missing scene falls back to the raw list', selectableIds([1, 2, 3]).length === 3);

// ---------------------------------------------------------------------------
console.log('\nnudging the raw created list vs the collapsed selection\n');

{
  const work = loadBuffer(fixture, 'fixture.rv4').document;
  const result = placeGear(work, indexDocument(work), 'Fixture Table', 15 * F, 15 * F);
  check('nudge fixture places', result.ok, result.reason);
  const shape = result.created?.[0] != null ? findById(work, result.created[0]) : undefined;
  const segment = shape?.children
    .find((child) => child.cls === 'RVGeometry')
    ?.children.find((child) => child.points[0]);
  check('the clone has an insertion point and an outline', !!shape?.points[0] && !!segment?.points[0]);

  if (shape?.points[0] && segment?.points[0] && result.created) {
    const insertion = { ...shape.points[0] };
    const local = { ...segment.points[0] };
    const dx = 1 * F;

    // This is what the UI used to do: select every created node and nudge them
    // all. Moving the shape shifts the insertion point; moving the geometry
    // then walks its outline, and moving the outline again shifts it a second
    // time. The chair travels farther than the nudge and its local drawing
    // is no longer centred on the insertion point.
    for (const id of result.created) {
      const node = findById(work, id);
      if (node) moveNode(work, node, dx, 0);
    }
    check(
      'nudging every created node also shifts the local outline',
      Math.abs(segment.points[0].x - local.x) > 1,
      `insertion ${shape.points[0].x - insertion.x}, local ${segment.points[0].x - local.x}`,
    );
  }
}

{
  const work = loadBuffer(fixture, 'fixture.rv4').document;
  const result = placeGear(work, indexDocument(work), 'Fixture Table', 15 * F, 15 * F);
  const shape = result.created?.[0] != null ? findById(work, result.created[0]) : undefined;
  const segment = shape?.children
    .find((child) => child.cls === 'RVGeometry')
    ?.children.find((child) => child.points[0]);
  if (shape?.points[0] && segment?.points[0] && result.created) {
    const insertion = { ...shape.points[0] };
    const local = { ...segment.points[0] };
    const dx = 1 * F;
    const collapsed = selectableIds(result.created, buildScene(work));
    for (const id of collapsed) {
      const node = findById(work, id);
      if (node) moveNode(work, node, dx, 0);
    }
    check(
      'nudging the collapsed selection moves only the insertion point',
      Math.abs(shape.points[0].x - insertion.x - dx) < 0.01,
    );
    check(
      'and leaves the local outline where the shape stores it',
      Math.abs(segment.points[0].x - local.x) < 0.01 && Math.abs(segment.points[0].y - local.y) < 0.01,
      `local moved by ${segment.points[0].x - local.x}`,
    );
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
