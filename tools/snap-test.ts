/**
 * Snapping: what a drag actually lands on.
 *
 *   npx tsx tools/snap-test.ts
 *
 * The behaviour that matters for this application is edge-to-edge. A stage is
 * built by butting decks together, an LED wall by butting panels together, and
 * a riser goes flush to a wall. Snapping used to offer only the moving
 * selection's centre as a candidate, so none of those was reachable by
 * dragging: the centre would have had to land on the other object's edge,
 * which is a different position entirely.
 */

import {
  applySnap,
  boundsOfMany,
  constrainSpanEnd,
  spanConstraintFor,
  type Bounds,
} from '../src/renderer/src/snap.js';

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

const F = 120;
/** One screen pixel is one plan unit, so tolerance is 7 units. */
const SCALE = 1;
const FREE = { shift: false, alt: false };

function box(x: number, y: number, w: number, h: number): Bounds {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

/** A 4ft x 8ft stage deck with its lower-left corner at (x, y). */
function deck(x: number, y: number): Bounds {
  return box(x, y, 8 * F, 4 * F);
}

console.log('\nedge to edge — the case the old rule could not reach');
{
  // A deck sitting at x = 0..960. Drag a second deck so its LEFT edge lands
  // 3 units short of the first deck's RIGHT edge: inside tolerance.
  const bounds = new Map<number, Bounds>([
    [1, deck(0, 0)],
    [2, deck(2000, 0)],
  ]);
  const wantLeftAt = 8 * F - 3;
  const raw = { dx: wantLeftAt - 2000, dy: 0 };

  const snapped = applySnap(bounds, [2], raw, 0, SCALE, true, 'imperial', FREE);
  const landedLeft = 2000 + snapped.dx;
  check(
    'a deck dragged beside another lands flush against it',
    Math.abs(landedLeft - 8 * F) < 1e-6,
    `left edge at ${landedLeft}, wanted ${8 * F}`,
  );
  check('and the guide is drawn on the shared edge', snapped.guides.x === 8 * F, `${snapped.guides.x}`);
}

console.log('\na run of decks can be butted up in sequence');
{
  const bounds = new Map<number, Bounds>([[1, deck(0, 0)]]);
  for (let i = 1; i <= 4; i++) {
    const target = i * 8 * F;
    const start = 5000 + i * 10;
    const id = 100 + i;
    // The moving object has to be in the map — that is where its own bounds,
    // and therefore its own edges, are read from.
    bounds.set(id, deck(start, 0));
    // Aim 4 units past the true seam — a realistic sloppy drag.
    const raw = { dx: target + 4 - start, dy: 0 };
    const snapped = applySnap(bounds, [id], raw, 0, SCALE, true, 'imperial', FREE);
    const x = start + snapped.dx;
    bounds.set(id, deck(x, 0));
    check(
      `deck ${i} seats flush at ${i * 8}ft`,
      Math.abs(x - target) < 1e-6,
      `landed at ${x / F}ft, wanted ${target / F}ft`,
    );
  }
}

console.log('\nedge beats centre when both are in reach');
{
  // A target whose right edge and centre are the same distance from two
  // different candidates on the moving box. Edge-to-edge should win.
  const target = box(1000, 0, 100, 100);
  const bounds = new Map<number, Bounds>([[1, target]]);
  const moving = box(1104, 0, 100, 100); // left edge 4 past target's right edge
  bounds.set(2, moving);

  const snapped = applySnap(bounds, [2], { dx: 0, dy: 0 }, 0, SCALE, true, 'imperial', FREE);
  const landedLeft = 1104 + snapped.dx;
  check(
    'the moving left edge takes the target right edge, not the centre',
    Math.abs(landedLeft - 1100) < 1e-6,
    `left edge landed at ${landedLeft}`,
  );
}

console.log('\ncentre alignment still works');
{
  const bounds = new Map<number, Bounds>([
    [1, box(0, 0, 200, 200)], // centre at 100
    [2, box(500, 0, 60, 60)], // centre at 530
  ]);
  // Drag so the moving centre is 3 short of the target centre.
  const raw = { dx: 100 - 3 - 530, dy: 0 };
  const snapped = applySnap(bounds, [2], raw, 0, SCALE, true, 'imperial', FREE);
  const landedCentre = 530 + snapped.dx;
  check(
    'a small object still centres on a large one',
    Math.abs(landedCentre - 100) < 1e-6,
    `centre landed at ${landedCentre}`,
  );
}

console.log('\nlarge selections snap — the silent 40-object cutoff is gone');
{
  const bounds = new Map<number, Bounds>();
  bounds.set(1, deck(0, 0));
  // 60 chairs moving together, well past the old limit.
  const selection: number[] = [];
  for (let i = 0; i < 60; i++) {
    const id = 200 + i;
    bounds.set(id, box(3000 + i * 20, 0, 18, 18));
    selection.push(id);
  }
  const group = boundsOfMany(bounds, selection)!;
  const raw = { dx: 8 * F - 3 - group.minX, dy: 0 };
  const snapped = applySnap(bounds, selection, raw, 0, SCALE, true, 'imperial', FREE);
  const landedMin = group.minX + snapped.dx;
  check(
    'a 60-object selection still snaps to an edge',
    Math.abs(landedMin - 8 * F) < 1e-6,
    `left edge landed at ${landedMin}, wanted ${8 * F}`,
  );
}

console.log('\nescape hatches still work');
{
  const bounds = new Map<number, Bounds>([
    [1, deck(0, 0)],
    [2, deck(2000, 0)],
  ]);
  const raw = { dx: 8 * F - 3 - 2000, dy: 0 };

  const alt = applySnap(bounds, [2], { ...raw }, 0, SCALE, true, 'imperial', {
    shift: false,
    alt: true,
  });
  check(
    'Alt drops object snapping and leaves the drag free',
    Math.abs(alt.dx - raw.dx) < 1e-6 && alt.guides.x === undefined,
    `dx ${alt.dx} vs raw ${raw.dx}`,
  );

  // With object snapping off the drag still clamps to the 1in interactive grid
  // — that is the documented behaviour of `editSnapStep`, and Alt is the way
  // out of it. What must NOT happen is the edge capturing the drag.
  // No guide is the signal that nothing captured the drag. The landed position
  // is not: a deck is a whole number of inches wide against a seam on an inch
  // boundary, so the 1in grid clamp puts it flush anyway. That is a coincidence
  // of this fixture, not edge snapping.
  const off = applySnap(bounds, [2], { ...raw }, 0, SCALE, false, 'imperial', FREE);
  check(
    'object snapping off means nothing captures the drag',
    off.guides.x === undefined && off.guides.y === undefined,
    `guides ${JSON.stringify(off.guides)}`,
  );
  check(
    'and the drag still lands on the 1in interactive grid',
    Math.abs(((2000 + off.dx + 480) % 10) - 0) < 1e-6,
    `centre at ${2000 + off.dx + 480}`,
  );
}

console.log('\ngrid snapping is the fallback, not the winner');
{
  const bounds = new Map<number, Bounds>([[1, box(9999, 9999, 10, 10)]]);
  const moving = new Map<number, Bounds>(bounds);
  moving.set(2, box(0, 0, 100, 100));
  // Nothing in reach, so the centre falls to the grid.
  const snapped = applySnap(moving, [2], { dx: 7, dy: 0 }, 12 * 10, SCALE, true, 'imperial', FREE);
  const centre = 50 + snapped.dx;
  check(
    'with nothing nearby the centre lands on the grid',
    Math.abs(centre % 10) < 1e-6,
    `centre at ${centre}`,
  );
  check('and no guide is drawn', snapped.guides.x === undefined);
}

/*
 * Shift regularises a span.
 *
 * The constraint step ran only for multi-point paths, so the rectangle,
 * ellipse, line, dimension and measure tools had no square, no circle and no
 * way to draw a truly horizontal or vertical run except by landing the pixel
 * exactly — in an application whose whole job is drawings that get built from.
 */
{
  const from = { x: 0, y: 0 };

  check('without Shift nothing is constrained', spanConstraintFor('rect', false) === 'none');
  check('a rectangle regularises', spanConstraintFor('rect', true) === 'regular');
  check('an ellipse regularises', spanConstraintFor('ellipse', true) === 'regular');
  check('a line snaps to an angle', spanConstraintFor('line', true) === 'angle');
  check('a measurement snaps to an angle', spanConstraintFor('measure', true) === 'angle');

  const square = constrainSpanEnd(from, { x: 10 * F, y: 4 * F }, 'regular');
  check('a square takes the longer side', square.x === 10 * F && square.y === 10 * F, JSON.stringify(square));
  const back = constrainSpanEnd(from, { x: -10 * F, y: 4 * F }, 'regular');
  check('and keeps the direction it was dragged', back.x === -10 * F && back.y === 10 * F, JSON.stringify(back));
  // Math.sign(0) is 0; using it would collapse the shape to nothing the moment
  // the pointer is level with its own start.
  const flat = constrainSpanEnd(from, { x: 8 * F, y: 0 }, 'regular');
  check('a pointer level with the start still makes a square', flat.x === 8 * F && flat.y === 8 * F, JSON.stringify(flat));

  const nearlyFlat = constrainSpanEnd(from, { x: 10 * F, y: 1 * F }, 'angle');
  check(
    'a nearly-level line becomes exactly level',
    Math.abs(nearlyFlat.y) < 1e-6 && nearlyFlat.x > 0,
    JSON.stringify(nearlyFlat),
  );
  const nearlyUp = constrainSpanEnd(from, { x: 1 * F, y: 10 * F }, 'angle');
  check('and a nearly-vertical one becomes vertical', Math.abs(nearlyUp.x) < 1e-6, JSON.stringify(nearlyUp));
  const diagonal = constrainSpanEnd(from, { x: 10 * F, y: 9 * F }, 'angle');
  check(
    'a near-diagonal snaps to 45 degrees',
    Math.abs(diagonal.x - diagonal.y) < 1e-6,
    JSON.stringify(diagonal),
  );
  check(
    'the constrained end keeps the length the pointer had',
    Math.abs(Math.hypot(diagonal.x, diagonal.y) - Math.hypot(10 * F, 9 * F)) < 1e-6,
  );
  const nowhere = constrainSpanEnd(from, from, 'angle');
  check('a zero-length span does not become NaN', Number.isFinite(nowhere.x) && Number.isFinite(nowhere.y));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
