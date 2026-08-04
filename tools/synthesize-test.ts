/**
 * Proves that objects built from scratch survive being written and read back.
 *
 * This is the gate the whole authoring plan rests on. Every other capability —
 * walls, curves, stages, parametric seating — needs objects that are not in the
 * file already, and the only reason the app could not create them was that
 * nobody had shown the byte layouts were reproducible.
 *
 * Two modes:
 *
 *   npx tsx tools/synthesize-test.ts
 *       runs against the synthetic fixture; no production data, safe in CI.
 *
 *   npx tsx tools/synthesize-test.ts "/Volumes/Prince/Roomviewer"
 *       additionally inserts a synthesized line into every editable file in the
 *       corpus and verifies each one. Nothing is written to disk.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { loadBuffer, loadFile, walk, UNITS_PER_FOOT, type RVDocument, type RVNode } from '../src/format/index.js';
import { packContainer, roundTrip, verifyWritable } from '../src/format/write.js';
import { appendChild, addRoot, indexDocument } from '../src/format/edit.js';
import {
  boxOutline,
  circleOutline,
  createContainer,
  createSegment,
  createShape,
  rectangleCorners,
} from '../src/format/synthesize.js';
import { buildScene } from '../src/format/scene.js';
import { enclosesArea } from '../src/format/style.js';
import { createBlankPlan, ROOM_PRESETS } from '../src/format/blank.js';
import { placeGear } from '../src/format/place.js';
import { convertSegmentKind } from '../src/format/path-edit.js';
import { deriveRoom, roomArea } from '../src/format/room.js';
import { fixturePlanBuffer } from './test-fixture.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
  return ok;
}

/** Finds the first container in a document that can take another child. */
function findContainer(doc: RVDocument, cls?: string): RVNode | null {
  for (const node of walk(doc)) {
    if (node.fields.childCountAt == null) continue;
    if (cls && node.cls !== cls) continue;
    return node;
  }
  return null;
}

function findByClass(doc: RVDocument, cls: string): RVNode[] {
  return [...walk(doc)].filter((n) => n.cls === cls);
}

/**
 * Puts a verified archive body back into the compound file it came from, which
 * is what saving does — reading the bytes back any other way would test the
 * serializer without testing the container.
 */
function reopen(originalFile: Buffer, body: Buffer) {
  return loadBuffer(packContainer(originalFile, body), 'written.rv4');
}

// ---------------------------------------------------------------------------
// Fixture tests
// ---------------------------------------------------------------------------

console.log('synthesis into the fixture plan\n');

const FIXTURE = fixturePlanBuffer({ walls: false });

{
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  check('the fixture round-trips before anything is added', roundTrip(loaded.document).identical);
}

{
  // The headline case: a line that exists in no file, written into a plan.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  const geometry = findContainer(doc, 'RVGeometry');

  const built = createSegment(doc, {
    cls: 'RVSegmentLine',
    points: [
      { x: -100, y: -50 },
      { x: 100, y: 50 },
    ],
  });

  if (
    check('a line is synthesized', built.ok && !!built.node, built.reason) &&
    check('there is a container to put it in', !!geometry)
  ) {
    const added = appendChild(doc, geometry!, built.node!);
    check('the line is added to the geometry', added.ok, added.reason);

    const verdict = verifyWritable(doc);
    check('the document with a from-scratch line verifies', verdict.ok, verdict.reason);

    if (verdict.ok) {
      const reread = reopen(FIXTURE, verdict.bytes!);
      const lines = findByClass(reread.document, 'RVSegmentLine');
      check('the line is there when the file is read back', lines.length === 1, `found ${lines.length}`);
      if (lines.length === 1) {
        const p = lines[0].points;
        check(
          'its coordinates survived exactly',
          p.length === 2 && p[0].x === -100 && p[0].y === -50 && p[1].x === 100 && p[1].y === 50,
          JSON.stringify(p),
        );
        check(
          'its bounds were computed from the points',
          lines[0].bounds.left === -100 && lines[0].bounds.bottom === 50,
          JSON.stringify(lines[0].bounds),
        );
      }
      check('the rewritten file round-trips against itself', roundTrip(reread.document).identical);
    }
  }
}

{
  // Direct Selection changes the binary class and point count, while keeping
  // the same object in its parent slot so selection and undo stay stable.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  const geometry = findContainer(doc, 'RVGeometry')!;
  const built = createSegment(doc, {
    cls: 'RVSegmentLine',
    points: [{ x: 100, y: 200 }, { x: 700, y: 500 }],
  });
  appendChild(doc, geometry, built.node!);
  const segment = built.node!;
  const stableId = segment.id;
  const nextId = doc.nextId;

  const curved = convertSegmentKind(doc, segment, 'curve');
  check('Direct Selection converts a line to a curve', curved.ok, curved.reason);
  check('the converted segment keeps its selection id', segment.id === stableId);
  check('curve conversion does not consume a document id', doc.nextId === nextId);
  check('the curve exposes two anchors and two controls', segment.cls === 'RVSegmentArc' && segment.points.length === 8);
  check(
    'a new curve keeps the original line visually straight',
    segment.points.slice(-4).every((point) => Math.abs((point.y - 200) * 600 - (point.x - 100) * 300) < 1e-6),
  );
  check('the converted curve verifies', verifyWritable(doc).ok, verifyWritable(doc).reason);

  const straight = convertSegmentKind(doc, segment, 'line');
  check('Direct Selection converts a curve back to a line', straight.ok, straight.reason);
  check('straightening keeps the same selection id', segment.id === stableId);
  check(
    'straightening keeps the two curve anchors',
    segment.cls === 'RVSegmentLine' && segment.points.length === 2 &&
      segment.points[0].x === 100 && segment.points[0].y === 200 &&
      segment.points[1].x === 700 && segment.points[1].y === 500,
  );
  const verified = verifyWritable(doc);
  check('the straightened line verifies', verified.ok, verified.reason);
}

{
  // Every synthesizable class, one at a time, each into a fresh document.
  const cases: Array<{ cls: 'RVSegmentLine' | 'RVSegmentRect' | 'RVSegmentPoly' | 'RVDimensionLine'; points: Array<[number, number]> }> = [
    { cls: 'RVSegmentLine', points: [[0, 0], [1200, 0]] },
    { cls: 'RVSegmentRect', points: [[-60, -60], [60, -60], [60, 60], [-60, 60]] },
    { cls: 'RVSegmentPoly', points: [[0, 0], [240, 0], [240, 240], [120, 360], [0, 240]] },
    { cls: 'RVDimensionLine', points: [[0, 600], [1200, 600]] },
  ];

  for (const c of cases) {
    const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
    const doc = loaded.document;
    const geometry = findContainer(doc, 'RVGeometry')!;
    const built = createSegment(doc, { cls: c.cls, points: c.points.map(([x, y]) => ({ x, y })) });
    if (!built.ok) {
      check(`${c.cls} is synthesized`, false, built.reason);
      continue;
    }
    appendChild(doc, geometry, built.node!);
    const verdict = verifyWritable(doc);
    if (!check(`${c.cls} verifies with ${c.points.length} points`, verdict.ok, verdict.reason)) continue;

    const reread = reopen(FIXTURE, verdict.bytes!);
    const found = findByClass(reread.document, c.cls);
    const target = c.cls === 'RVDimensionLine' || c.cls === 'RVSegmentRect' ? found.length === 2 : found.length === 1;
    check(`${c.cls} is found again after the write`, target, `found ${found.length}`);
    const mine = found.find((n) => n.points.length === c.points.length && n.points[0].x === c.points[0][0]);
    check(
      `${c.cls} keeps every coordinate`,
      !!mine && mine.points.every((p, i) => p.x === c.points[i][0] && p.y === c.points[i][1]),
      mine ? JSON.stringify(mine.points) : 'not found',
    );
  }
}

{
  // A container built from scratch, holding a segment built from scratch —
  // the shape every later phase needs (a room's walls, a stage's decks).
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;

  const group = createContainer(doc, { cls: 'RVGeometry' });
  check('a container is synthesized', group.ok, group.reason);

  const walls: Array<[number, number, number, number]> = [
    [0, 0, 40 * UNITS_PER_FOOT, 0],
    [40 * UNITS_PER_FOOT, 0, 40 * UNITS_PER_FOOT, 30 * UNITS_PER_FOOT],
    [40 * UNITS_PER_FOOT, 30 * UNITS_PER_FOOT, 0, 30 * UNITS_PER_FOOT],
    [0, 30 * UNITS_PER_FOOT, 0, 0],
  ];
  for (const [x1, y1, x2, y2] of walls) {
    const seg = createSegment(doc, {
      cls: 'RVSegmentLine',
      points: [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
    });
    if (seg.ok) appendChild(doc, group.node!, seg.node!);
  }
  check('four walls go into the new container', group.node!.slots.length === 4);

  const host = findContainer(doc, 'RVGeometry')!;
  appendChild(doc, host, group.node!);

  const verdict = verifyWritable(doc);
  if (check('a from-scratch container of from-scratch walls verifies', verdict.ok, verdict.reason)) {
    const reread = reopen(FIXTURE, verdict.bytes!);
    const lines = findByClass(reread.document, 'RVSegmentLine');
    check('all four walls read back', lines.length === 4, `found ${lines.length}`);
    const perimeter = lines.reduce(
      (sum, l) => sum + Math.hypot(l.points[1].x - l.points[0].x, l.points[1].y - l.points[0].y),
      0,
    );
    check(
      'the walls measure a 40 x 30 room',
      Math.round(perimeter / UNITS_PER_FOOT) === 140,
      `${perimeter / UNITS_PER_FOOT} ft`,
    );
  }
}

{
  // Objects at document level rather than inside a container.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  const built = createSegment(doc, {
    cls: 'RVSegmentLine',
    points: [
      { x: 5000, y: 5000 },
      { x: 6000, y: 5000 },
    ],
  });
  const added = addRoot(doc, built.node!);
  check('a synthesized object can be added at document level', added.ok, added.reason);
  const verdict = verifyWritable(doc);
  check('a document-level synthesized object verifies', verdict.ok, verdict.reason);
}

{
  // Guard rails.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  check(
    'a line with three points is refused',
    !createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }).ok,
  );
  check(
    'a rectangle with two points is refused',
    !createSegment(doc, { cls: 'RVSegmentRect', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).ok,
  );
  check(
    'coordinates outside the format range are refused',
    !createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: 0, y: 0 }, { x: 1e9, y: 0 }] }).ok,
  );
  check(
    'a non-finite coordinate is refused',
    !createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: 0, y: 0 }, { x: NaN, y: 0 }] }).ok,
  );
  const index = indexDocument(doc);
  void index;
  const seg = findByClass(doc, 'RVSegmentRect')[0];
  check(
    'a segment cannot be used as a parent',
    !appendChild(doc, seg, createSegment(doc, { cls: 'RVSegmentLine', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }).node!).ok,
  );
}

{
  // The style block must be borrowed when the document has a segment of the
  // same class, because those bytes carry pen and fill settings we never decoded.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  const fromRect = createSegment(doc, {
    cls: 'RVSegmentRect',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  });
  check('style bytes are borrowed when the class is already present', fromRect.borrowedStyle === true);

  const fromLine = createSegment(doc, {
    cls: 'RVSegmentLine',
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  });
  check(
    'style bytes fall back to the default when the class is absent',
    fromLine.borrowedStyle === false,
  );
}

{
  // A placed shape built from scratch — what a custom-shape editor produces,
  // and what lets a blank plan take its first item.
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;

  const round = createShape(doc, {
    name: 'Round 66" (custom)',
    x: 5000,
    y: 4000,
    outline: circleOutline(660),
  });
  check('a placed shape is synthesized', round.ok, round.reason);
  check('with its outline attached', round.node!.children.length === 1);

  const added = addRoot(doc, round.node!);
  check('and it goes into the document', added.ok, added.reason);

  const verdict = verifyWritable(doc);
  check('a from-scratch placed shape verifies', verdict.ok, verdict.reason);

  if (verdict.ok) {
    const reread = reopen(FIXTURE, verdict.bytes!);
    const shapes = findByClass(reread.document, 'RVShape');
    check('it reads back as a placed shape', shapes.length === 2, `${shapes.length}`);
    const mine = shapes.find((s) => s.labels.includes('Round 66" (custom)'));
    check('carrying its catalogue name', !!mine, shapes.flatMap((s) => s.labels).join(' | '));
    check('at its insertion point', mine!.points[0].x === 5000 && mine!.points[0].y === 4000);
    check('with geometry inside it', mine!.children.some((c) => c.cls === 'RVGeometry'));

    const scene = buildScene(reread.document);
    const drawn = scene.primitives.filter((p) => p.owner === 'Round 66" (custom)');
    check('and the scene draws it at the right place', drawn.length === 1, `${drawn.length}`);
    // The outline is local, so the scene must offset it by the insertion point.
    const xs = drawn[0].pts.filter((_, i) => i % 2 === 0);
    check(
      'centred on where it was placed',
      Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 5000) < 1,
      `${(Math.min(...xs) + Math.max(...xs)) / 2}`,
    );
    check('at the right diameter', Math.abs(Math.max(...xs) - Math.min(...xs) - 660) < 1, `${Math.max(...xs) - Math.min(...xs)}`);
    check('and it appears in the inventory', scene.inventory.some((i) => i.name === 'Round 66" (custom)'));
  }

  {
    // A curved outline must stay curved. `createShape` used to emit only lines
    // and polylines, so a run of four control points came out as the three
    // sides of the Bézier's control polygon — a half-round table redrawn as a
    // box a third too deep.
    const r = 900;
    const k = (r * 4) / 3; // control offset for a semicircle
    const top = [
      { x: r, y: 0 },
      { x: r, y: k },
      { x: -r, y: k },
      { x: -r, y: 0 },
    ];
    const bottom = top.map((p) => ({ x: p.x, y: -p.y }));

    const table = createShape(doc, {
      name: 'Round 180" (curved)',
      x: 3000,
      y: 3000,
      outline: [{ curve: top }, { curve: bottom }],
    });
    check('a curved outline is synthesized', table.ok, table.reason);

    const arcs = table.node!.children[0].children;
    check('as real arc segments', arcs.every((a) => a.cls === 'RVSegmentArc'), arcs.map((a) => a.cls).join(' '));
    check('each holding eight points', arcs.every((a) => a.points.length === 8));
    check(
      'whose leading four are the weighted control polygon',
      arcs.every((a) => {
        const [a0, a1, a2, a3, p0, p1, p2, p3] = a.points;
        const eq = (u: typeof a0, v: typeof a0, s = 1) =>
          Math.abs(u.x - v.x * s) < 1e-9 && Math.abs(u.y - v.y * s) < 1e-9;
        return eq(a0, p0) && eq(a3, p3) && eq(a1, p1, 3) && eq(a2, p2, 3);
      }),
    );
    // The rect measures the curve, not the control points: a semicircle of
    // radius 900 reaches y = 900, while its control points stand at y = 1200.
    check(
      'and a rect measuring the curve rather than its control points',
      arcs[0].bounds.bottom === r && arcs[0].bounds.top === 0,
      JSON.stringify(arcs[0].bounds),
    );
    check(
      'so the shape is as wide as it is tall',
      table.node!.bounds.right - table.node!.bounds.left === 2 * r &&
        table.node!.bounds.bottom - table.node!.bounds.top === 2 * r,
      JSON.stringify(table.node!.bounds),
    );

    check('it goes into the document', addRoot(doc, table.node!).ok);
    const curved = verifyWritable(doc);
    check('a document holding synthesized arcs verifies', curved.ok, curved.reason);
    if (curved.ok) {
      const reread = reopen(FIXTURE, curved.bytes!);
      const back = findByClass(reread.document, 'RVSegmentArc');
      check('the arcs read back as arcs', back.length === 2, `${back.length}`);
      check('with all eight points intact', back.every((a) => a.points.length === 8));
      check(
        'and the drawn curve unchanged',
        back[0].points.slice(-4).every((p, i) => Math.abs(p.x - top[i].x) < 1e-9 && Math.abs(p.y - top[i].y) < 1e-9),
      );
      const scene = buildScene(reread.document);
      const beziers = scene.primitives.filter((p) => p.owner === 'Round 180" (curved)' && p.type === 'bezier');
      check('and the renderer draws them as curves', beziers.length === 2, `${beziers.length}`);
    }
  }

  {
    // A rectangular outline must stay a rectangle. `createShape` used to emit
    // every straight-sided run as a polyline, so rebuilding a plan from its
    // shape library produced 5,745 `RVSegmentPoly` where the original held
    // 5,768 `RVSegmentRect` — the drawing looked right, but every footprint was
    // an open polyline: not closed by the renderer, not fillable, and a stroke
    // to click rather than an area.
    /** An 8ft x 4ft riser top about the origin, in tenths of an inch. */
    const RECT = [
      { x: -480, y: -240 },
      { x: 480, y: -240 },
      { x: 480, y: 240 },
      { x: -480, y: 240 },
    ];
    const turn = (p: { x: number; y: number }, a: number) => ({
      x: p.x * Math.cos(a) - p.y * Math.sin(a),
      y: p.x * Math.sin(a) + p.y * Math.cos(a),
    });
    const TURNED = RECT.map((p) => turn(p, 0.4));
    const SKEWED = [
      { x: -480, y: -240 },
      { x: 480, y: -240 },
      { x: 560, y: 240 },
      { x: -400, y: 240 },
    ];

    check('an axis-aligned rectangle is recognised', rectangleCorners(RECT)!.length === 4);
    check('and so is the same rectangle written closed', rectangleCorners([...RECT, RECT[0]])!.length === 4);
    // Room Viewer stores turned rectangles under the same class: 1,257 of the
    // 5,768 in the plan this rebuilds are rotated, and the cached rect is
    // 0,0,0,0 in 99.4% of corpus rects, so the four corners are what the format
    // carries.
    check('a rotated rectangle is still a rectangle', rectangleCorners(TURNED)!.length === 4);
    check('a parallelogram is not', rectangleCorners(SKEWED) === null);
    check('nor is a run that does not close', rectangleCorners([...RECT, { x: 0, y: 0 }]) === null);
    check('nor is one with a collapsed side', rectangleCorners([RECT[0], RECT[0], RECT[2], RECT[3]]) === null);

    const riser = createShape(doc, {
      name: 'Riser 8x4 (rect)',
      x: 6000,
      y: 3000,
      outline: [{ rect: RECT }, { rect: SKEWED }, RECT],
    });
    check('a rectangular outline is synthesized', riser.ok, riser.reason);
    const runs = riser.node!.children[0].children;
    check(
      'a marked rectangle becomes a rect, a marked non-rectangle and an unmarked run stay polys',
      runs.map((r) => r.cls).join(' ') === 'RVSegmentRect RVSegmentPoly RVSegmentPoly',
      runs.map((r) => r.cls).join(' '),
    );
    check('the rect holds exactly four corners', runs[0].points.length === 4);
    check('stamped with the rect kind code', runs[0].kind === 2);

    check('it goes into the document', addRoot(doc, riser.node!).ok);
    const boxed = verifyWritable(doc);
    check('a document holding a synthesized rect verifies', boxed.ok, boxed.reason);
    if (boxed.ok) {
      const reread = reopen(FIXTURE, boxed.bytes!);
      const back = findByClass(reread.document, 'RVSegmentRect').filter((r) => r.points.length === 4);
      const mine = back.find((r) => r.points.every((p, i) => Math.abs(p.x - RECT[i].x) < 1e-9 && Math.abs(p.y - RECT[i].y) < 1e-9));
      check('the rect reads back with its corners intact', mine != null);
      const scene = buildScene(reread.document);
      const polygons = scene.primitives.filter((p) => p.owner === 'Riser 8x4 (rect)' && p.type === 'polygon');
      check('and the renderer draws it as a closed area', polygons.length === 1, `${polygons.length}`);
      check(
        'which a deck would fill',
        polygons.length === 1 && enclosesArea(polygons[0]),
      );
    }
  }

  const box = createShape(doc, { name: 'Custom Riser', x: 0, y: 0, outline: boxOutline(4 * UNITS_PER_FOOT, 8 * UNITS_PER_FOOT) });
  check('a box outline works too', box.ok, box.reason);
  check('an unnamed shape is refused', !createShape(doc, { name: '  ', x: 0, y: 0, outline: boxOutline(10, 10) }).ok);
  check('a shape with no outline is refused', !createShape(doc, { name: 'x', x: 0, y: 0, outline: [] }).ok);
}

// ---------------------------------------------------------------------------
console.log('\na plan created from nothing\n');

{
  const blank = createBlankPlan();
  check('an empty plan is created', blank.ok, blank.reason);

  const loaded = loadBuffer(blank.file!, 'New.rv4');
  check('it opens', !!loaded.document);
  check('with no parse warnings', loaded.document.warnings.length === 0, loaded.document.warnings.map((w) => w.message).join(' | '));
  check('and it is editable, not read-only', roundTrip(loaded.document).identical);
  check('it has a room definition', findByClass(loaded.document, 'RVRoomDef').length === 2);
  check('and a wall container', findByClass(loaded.document, 'RVWalls').length === 1);
  check('with no walls in it yet', findByClass(loaded.document, 'RVSegmentLine').length === 0);
}

{
  const sized = createBlankPlan({ room: { width: 60 * UNITS_PER_FOOT, depth: 40 * UNITS_PER_FOOT }, roomName: 'Ballroom' });
  check('a plan can be created with a room already in it', sized.ok, sized.reason);

  const loaded = loadBuffer(sized.file!, 'New.rv4');
  check('the room is drawn as four walls', findByClass(loaded.document, 'RVSegmentLine').length === 4);
  check('it round-trips', roundTrip(loaded.document).identical);

  const derived = deriveRoom(loaded.document);
  check('and reads back as a room, not as furniture', derived.source === 'walls', derived.source);
  check('at the size asked for', Math.round(roomArea(derived.room) / (120 * 120)) === 2400, `${roomArea(derived.room) / (120 * 120)}`);

  check('a room with no size is refused', !createBlankPlan({ room: { width: 0, depth: 100 } }).ok);
  check('an absurd room is refused', !createBlankPlan({ room: { width: 1e9, depth: 100 } }).ok);
  check('every preset is usable', ROOM_PRESETS.every((p) => p.width >= 0 && p.depth >= 0));
}

{
  const advanced = createBlankPlan({
    roomName: 'Curved ballroom',
    roomSpec: {
      shape: 'rounded',
      width: 60 * UNITS_PER_FOOT,
      depth: 40 * UNITS_PER_FOOT,
      cornerRadius: 4 * UNITS_PER_FOOT,
    },
    autoDimensions: 'imperial',
  });
  check('New Plan writes advanced rounded geometry', advanced.ok, advanced.reason);
  const loaded = loadBuffer(advanced.file!, 'Curved ballroom.rv4');
  check('the advanced new plan round-trips', roundTrip(loaded.document).identical);
  check('rounded corners are emitted as editable wall geometry', findByClass(loaded.document, 'RVSegmentPoly').length === 4);
  check('New Plan can add initial dimensions', findByClass(loaded.document, 'RVDimensionLine').length > 0);
}

{
  // The point of a new plan: you can put something on it. Before synthesis this
  // failed outright, because there was no shape in the file to clone.
  const blank = createBlankPlan({ room: { width: 60 * UNITS_PER_FOOT, depth: 40 * UNITS_PER_FOOT } });
  const loaded = loadBuffer(blank.file!, 'New.rv4');
  const doc = loaded.document;

  const placed = placeGear(doc, indexDocument(doc), 'Round 60"', 20 * UNITS_PER_FOOT, 20 * UNITS_PER_FOOT);
  check('gear can be placed on a brand-new plan', placed.ok, placed.reason);
  check(
    'and it was built rather than copied',
    placed.method === 'synthesized' || placed.method === 'box',
    placed.method,
  );

  const verdict = verifyWritable(doc);
  check('the result verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(blank.file!, verdict.bytes!), 'placed.rv4').document;
  check('the item is there on reopening', findByClass(reread, 'RVShape').length === 1);
  check('with its name', findByClass(reread, 'RVShape')[0].labels.includes('Round 60"'), findByClass(reread, 'RVShape')[0].labels.join(' | '));

  // And a second one clones the first, which is the normal path.
  const again = placeGear(doc, indexDocument(doc), 'Round 60"', 30 * UNITS_PER_FOOT, 20 * UNITS_PER_FOOT);
  check('a second placement matches the first', again.ok && again.method === 'matched', again.method);
  check('and still verifies', verifyWritable(doc).ok);
}

// ---------------------------------------------------------------------------
// Corpus mode
// ---------------------------------------------------------------------------

const CORPUS = process.argv[2];
const EXTENSIONS = new Set(['.rv4', '.rs4', '.se4', '.ds4', '.add', '.stk', '.lib', '.rsd']);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (!entry.name.startsWith('._') && EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(p);
  }
  return out;
}

if (CORPUS) {
  console.log(`\nsynthesis across the corpus at ${CORPUS}\n`);
  const files = collect(CORPUS).sort();
  let editable = 0;
  let verified = 0;
  let refused = 0;
  const reasons: Record<string, number> = {};

  for (const file of files) {
    let doc: RVDocument;
    try {
      doc = loadFile(file).document;
    } catch {
      continue;
    }
    // Only files that already pass the editing gate are candidates; the others
    // are read-only for reasons that have nothing to do with synthesis.
    if (!roundTrip(doc).identical) continue;
    editable++;

    const host = findContainer(doc);
    const built = createSegment(doc, {
      cls: 'RVSegmentLine',
      points: [
        { x: 0, y: 0 },
        { x: UNITS_PER_FOOT, y: 0 },
      ],
    });
    if (!built.ok) {
      refused++;
      reasons[built.reason ?? 'unknown'] = (reasons[built.reason ?? 'unknown'] ?? 0) + 1;
      continue;
    }

    const added = host ? appendChild(doc, host, built.node!) : addRoot(doc, built.node!);
    if (!added.ok) {
      refused++;
      reasons[added.reason ?? 'unknown'] = (reasons[added.reason ?? 'unknown'] ?? 0) + 1;
      continue;
    }

    const verdict = verifyWritable(doc);
    if (verdict.ok) verified++;
    else {
      refused++;
      const key = (verdict.reason ?? 'unknown').replace(/\d+/g, 'N');
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }

  const pct = editable ? ((verified / editable) * 100).toFixed(1) : '0.0';
  console.log(`  files scanned          ${files.length}`);
  console.log(`  editable (round-trips) ${editable}`);
  console.log(`  synthesis verified     ${verified}  (${pct}%)`);
  console.log(`  refused                ${refused}`);
  if (Object.keys(reasons).length) {
    console.log('\n  reasons');
    for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${String(n).padStart(5)}  ${k}`);
    }
  }
  // A refusal is a safe outcome — the file is left alone — but a low rate means
  // the layouts are less general than they look, so it fails the run.
  check('synthesis verifies for at least 95% of editable files', editable > 0 && verified / editable >= 0.95);
} else {
  console.log('\n(no corpus path given — run with a directory to verify against real plans)');
  void readFileSync;
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
