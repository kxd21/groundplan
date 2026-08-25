/**
 * Boolean geometry on arbitrary polygons.
 *
 *   npx tsx tools/polygon-boolean-test.ts
 *
 * The rectilinear decomposition this replaces was exact and could not
 * represent a diagonal or an arc. These checks are mostly about the cases it
 * refused: triangles, circles, angled walls, and the degenerate ones that
 * break naive clippers — shared edges, touching corners, one shape entirely
 * inside another.
 *
 * Areas are checked rather than vertex lists, because there are many correct
 * vertex orders for the same shape and only one correct area.
 */

import { combinePolygons, pointInRing, ringArea, type Point } from '../src/format/polygon-boolean.js';

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

const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** A regular polygon, for circles and triangles. */
const ngon = (cx: number, cy: number, radius: number, sides: number, rotate = 0): Point[] =>
  Array.from({ length: sides }, (_, i) => {
    const angle = rotate + (i * 2 * Math.PI) / sides;
    return { x: Math.round(cx + radius * Math.cos(angle)), y: Math.round(cy + radius * Math.sin(angle)) };
  });

/** Total area of a result's outers minus its holes. */
function netArea(result: ReturnType<typeof combinePolygons>): number {
  if (!result) return 0;
  const outer = result.outers.reduce((sum, ring) => sum + ringArea(ring), 0);
  const hole = result.holes.reduce((sum, ring) => sum + ringArea(ring), 0);
  return outer - hole;
}

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;

console.log('\ntwo overlapping rectangles — the case that already worked');
{
  const a = rect(0, 0, 100, 100);
  const b = rect(50, 50, 100, 100);

  check('union area is both minus the overlap', near(netArea(combinePolygons(a, b, 'union')), 10000 + 10000 - 2500), `${netArea(combinePolygons(a, b, 'union'))}`);
  check('intersection is the overlap', near(netArea(combinePolygons(a, b, 'intersection')), 2500), `${netArea(combinePolygons(a, b, 'intersection'))}`);
  check('difference removes the overlap', near(netArea(combinePolygons(a, b, 'difference')), 10000 - 2500), `${netArea(combinePolygons(a, b, 'difference'))}`);
}

console.log('\na rectangle and a triangle — refused outright before');
{
  const room = rect(0, 0, 200, 100);
  // A right triangle sitting on the room's right edge.
  const wing: Point[] = [
    { x: 200, y: 0 },
    { x: 300, y: 0 },
    { x: 200, y: 100 },
  ];
  const union = combinePolygons(room, wing, 'union');
  check('a triangle unions onto a rectangle', !!union);
  check(
    'and the area is the sum, since they only share an edge',
    near(netArea(union), 20000 + 5000),
    `${netArea(union)}`,
  );
  check('the result is one ring, not two', union?.outers.length === 1, `${union?.outers.length}`);
}

console.log('\na rectangle and a circle');
{
  const room = rect(0, 0, 400, 200);
  // A 64-segment circle, the same flattening the room builder uses for arcs.
  const bay = ngon(400, 100, 80, 64);

  const union = combinePolygons(room, bay, 'union');
  check('a circle unions onto a rectangle', !!union);
  // Half the circle is outside the room's right edge.
  const circleArea = ringArea(bay);
  check(
    'adding a bay adds about half the circle',
    near(netArea(union), 80000 + circleArea / 2, circleArea * 0.02),
    `${netArea(union)} vs ${80000 + circleArea / 2}`,
  );

  const cut = combinePolygons(room, ngon(200, 100, 50, 64), 'difference');
  check('a circle cuts a hole in the middle of a room', !!cut);
  check('leaving a hole rather than a bite', cut?.holes.length === 1, `${cut?.holes.length} holes`);
  check(
    'and the net area is the room less the circle',
    near(netArea(cut), 80000 - ringArea(ngon(200, 100, 50, 64)), 30),
    `${netArea(cut)}`,
  );
}

console.log('\nangled walls');
{
  // A room canted at 30 degrees, unioned with an axis-aligned foyer.
  const canted = ngon(0, 0, 200, 4, Math.PI / 6);
  const foyer = rect(0, -400, 300, 300);
  const union = combinePolygons(canted, foyer, 'union');
  check('an angled outline combines at all', !!union);
  check(
    'and the union is at least as large as the larger operand',
    netArea(union) >= Math.max(ringArea(canted), ringArea(foyer)) - 2,
    `${netArea(union)} vs ${Math.max(ringArea(canted), ringArea(foyer))}`,
  );
}

console.log('\nthe degenerate cases that break naive clippers');
{
  const a = rect(0, 0, 100, 100);

  // Sharing a whole edge — the commonest case when adding to a room.
  const abutting = rect(100, 0, 100, 100);
  check(
    'two rooms sharing a wall union into one',
    near(netArea(combinePolygons(a, abutting, 'union')), 20000),
    `${netArea(combinePolygons(a, abutting, 'union'))}`,
  );
  check(
    'and share no interior, so intersection is empty',
    netArea(combinePolygons(a, abutting, 'intersection')) === 0,
    `${netArea(combinePolygons(a, abutting, 'intersection'))}`,
  );

  // Touching at a single corner.
  const corner = rect(100, 100, 100, 100);
  check(
    'two rooms touching at a corner union to their sum',
    near(netArea(combinePolygons(a, corner, 'union')), 20000),
    `${netArea(combinePolygons(a, corner, 'union'))}`,
  );

  // Identical outlines.
  check('a shape unioned with itself is itself', near(netArea(combinePolygons(a, rect(0, 0, 100, 100), 'union')), 10000), `${netArea(combinePolygons(a, rect(0, 0, 100, 100), 'union'))}`);
  check('and intersected with itself is itself', near(netArea(combinePolygons(a, rect(0, 0, 100, 100), 'intersection')), 10000), `${netArea(combinePolygons(a, rect(0, 0, 100, 100), 'intersection'))}`);

  // One fully inside the other.
  const inner = rect(25, 25, 50, 50);
  check('a contained shape does not change a union', near(netArea(combinePolygons(a, inner, 'union')), 10000), `${netArea(combinePolygons(a, inner, 'union'))}`);
  check('is the whole of an intersection', near(netArea(combinePolygons(a, inner, 'intersection')), 2500), `${netArea(combinePolygons(a, inner, 'intersection'))}`);
  const holed = combinePolygons(a, inner, 'difference');
  check('and leaves a hole when cut out', holed?.holes.length === 1, `${holed?.holes.length}`);
  check('with the right net area', near(netArea(holed), 7500), `${netArea(holed)}`);

  // Disjoint.
  const far = rect(1000, 1000, 50, 50);
  check('disjoint shapes intersect to nothing', netArea(combinePolygons(a, far, 'intersection')) === 0);
  check(
    'and a difference against something disjoint changes nothing',
    near(netArea(combinePolygons(a, far, 'difference')), 10000),
    `${netArea(combinePolygons(a, far, 'difference'))}`,
  );
}

console.log('\nthe answer is honest when there is nothing left');
{
  const a = rect(0, 0, 100, 100);
  check('a shape minus itself is empty', netArea(combinePolygons(a, rect(0, 0, 100, 100), 'difference')) === 0);
  check(
    'a shape minus something bigger is empty',
    netArea(combinePolygons(a, rect(-50, -50, 300, 300), 'difference')) === 0,
    `${netArea(combinePolygons(a, rect(-50, -50, 300, 300), 'difference'))}`,
  );
  check('a degenerate operand is refused', combinePolygons(a, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 'union') === null);
}

console.log('\nwinding is independent of how the caller wound its outline');
{
  const clockwise = [...rect(0, 0, 100, 100)].reverse();
  const other = rect(50, 0, 100, 100);
  check(
    'a clockwise subject gives the same union area',
    near(netArea(combinePolygons(clockwise, other, 'union')), 15000),
    `${netArea(combinePolygons(clockwise, other, 'union'))}`,
  );
  check(
    'and the same intersection area',
    near(netArea(combinePolygons(clockwise, other, 'intersection')), 5000),
    `${netArea(combinePolygons(clockwise, other, 'intersection'))}`,
  );
}

console.log('\npoint-in-ring holds up on the shapes above');
{
  const ring = ngon(0, 0, 100, 6);
  check('the centre is inside', pointInRing({ x: 0, y: 0 }, ring));
  check('a far point is outside', !pointInRing({ x: 500, y: 500 }, ring));
  check('a point just inside an edge is inside', pointInRing({ x: 0, y: 80 }, ring));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
