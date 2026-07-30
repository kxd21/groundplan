/**
 * Room authoring: creating a room, changing its shape, and drawing it into the
 * plan without drawing it twice.
 *
 *   npx tsx tools/room-authoring-test.ts
 */

import { loadBuffer, walk, UNITS_PER_FOOT } from '../src/format/index.js';
import { packContainer, verifyWritable } from '../src/format/write.js';
import {
  addCorner,
  combineRooms,
  corners,
  curveWall,
  isAxisAligned,
  moveCorner,
  offsetWall,
  rectRoom,
  removeCorner,
  roomProblems,
  setWallLength,
  setWallRadius,
} from '../src/format/room-edit.js';
import { applyRoom } from '../src/format/room-render.js';
import {
  deriveRoom,
  rectangularRoom,
  roomArea,
  roomFromPolygon,
  roomPerimeter,
  simplifyCollinear,
  wall,
} from '../src/format/room.js';
import { toSquareFeet } from '../src/format/units.js';
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

const F = UNITS_PER_FOOT;
const sqft = (room: Parameters<typeof roomArea>[0]) => Math.round(toSquareFeet(roomArea(room)));

// ---------------------------------------------------------------------------
console.log('combining rooms\n');

{
  // Two ballrooms with the air wall open: 40x30 beside 20x30.
  const a = rectangularRoom(40 * F, 30 * F, 'Ballroom A');
  const b = rectRoom(40 * F, 0, 20 * F, 30 * F, 'Ballroom B');

  const joined = combineRooms(a, b, 'union');
  check('two adjoining rooms combine', joined.ok, joined.reason);
  check('the combined area is the sum', sqft(joined.room!) === 1200 + 600, `${sqft(joined.room!)}`);
  check(
    'the shared wall is gone, so it is still a rectangle',
    joined.room!.walls.length === 4,
    `${joined.room!.walls.length} walls`,
  );
  check(
    'and it measures 60 x 30',
    Math.round(roomPerimeter(joined.room!) / F) === 180,
    `${roomPerimeter(joined.room!) / F}`,
  );
}

{
  // An L-shape from a union of two rectangles that only partly overlap edges.
  const a = rectangularRoom(40 * F, 15 * F, 'Hall');
  const b = rectRoom(0, 15 * F, 20 * F, 15 * F, 'Wing');
  const joined = combineRooms(a, b, 'union');
  check('an L-shape can be built by union', joined.ok, joined.reason);
  check('it has six corners', joined.room!.walls.length === 6, `${joined.room!.walls.length}`);
  check('and 900 sq ft', sqft(joined.room!) === 900, `${sqft(joined.room!)}`);
}

{
  // A service corridor cut out of one end.
  const hall = rectangularRoom(40 * F, 30 * F, 'Hall');
  const corridor = rectRoom(35 * F, 0, 5 * F, 30 * F, 'Corridor');
  const cut = combineRooms(hall, corridor, 'difference');
  check('a corridor can be cut out', cut.ok, cut.reason);
  check('the floor drops by the corridor', sqft(cut.room!) === 1200 - 150, `${sqft(cut.room!)}`);
  check('and it is still a rectangle', cut.room!.walls.length === 4);
}

{
  // A cut-out in the middle becomes a hole, not a missing bite.
  const hall = rectangularRoom(40 * F, 30 * F, 'Hall');
  const core = rectRoom(15 * F, 10 * F, 6 * F, 6 * F, 'Core');
  const cut = combineRooms(hall, core, 'difference');
  check('a cut-out in the middle becomes a hole', cut.ok && cut.room!.holes.length === 1, cut.reason);
  check('the floor drops by the hole', sqft(cut.room!) === 1200 - 36, `${sqft(cut.room!)}`);
}

{
  const a = rectangularRoom(40 * F, 30 * F);
  const b = rectRoom(20 * F, 15 * F, 40 * F, 30 * F);
  const overlap = combineRooms(a, b, 'intersection');
  check('an intersection is the overlap', overlap.ok && sqft(overlap.room!) === 20 * 15, `${sqft(overlap.room!)}`);

  const apart = combineRooms(a, rectRoom(100 * F, 100 * F, 10 * F, 10 * F), 'intersection');
  check('rooms that do not touch refuse to intersect', !apart.ok);
  check('and say so plainly', (apart.reason ?? '').includes('do not overlap'), apart.reason);
}

{
  // The honest refusal: a diagonal wall cannot be combined exactly.
  const angled = roomFromPolygon([
    { x: 0, y: 0 },
    { x: 40 * F, y: 0 },
    { x: 30 * F, y: 30 * F },
    { x: 0, y: 30 * F },
  ]);
  check('an angled room is not axis-aligned', !isAxisAligned(angled.walls));
  const refused = combineRooms(angled, rectRoom(0, 0, 10 * F, 10 * F), 'difference');
  check('combining an angled room is refused, not approximated', !refused.ok);
  check('and the refusal says what to do instead', (refused.reason ?? '').includes('corners'), refused.reason);
}

check(
  'collinear points collapse to real corners',
  simplifyCollinear([
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]).length === 4,
);

// ---------------------------------------------------------------------------
console.log('\nediting corners\n');

{
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  check('a rectangle has four corners', corners(room).length === 4);

  const pulled = moveCorner(room, 2, { x: 30 * F, y: 30 * F });
  check('a corner moves', pulled.ok, pulled.reason);
  check('the two walls that meet there follow it', roomProblems(pulled.room!).length === 0, roomProblems(pulled.room!).join(' '));
  check('the area changes with it', sqft(pulled.room!) < 1200, `${sqft(pulled.room!)}`);

  const split = addCorner(room, 0);
  check('a wall splits in two', split.ok && split.room!.walls.length === 5);
  check('splitting does not change the room', sqft(split.room!) === 1200);
  const rejoined = removeCorner(split.room!, 1);
  check('removing the new corner restores it', rejoined.ok && rejoined.room!.walls.length === 4);
  check('and the area is back', sqft(rejoined.room!) === 1200);

  check('a triangle refuses to lose a corner', !removeCorner(roomFromPolygon([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ]), 0).ok);

  const deeper = offsetWall(room, 1, 2 * F);
  check('a wall moves out by two feet', deeper.ok, deeper.reason);
  check('which adds 60 sq ft', sqft(deeper.room!) === 1200 + 60, `${sqft(deeper.room!)}`);
  check('and leaves the room closed', roomProblems(deeper.room!).length === 0);

  const bowed = curveWall(room, 0, 0.25);
  check('a wall can be bowed', bowed.ok && !!bowed.room!.walls[0].bulge);
  check('which adds floor', roomArea(bowed.room!) !== roomArea(room));
  const straightened = curveWall(bowed.room!, 0, 0);
  check('and straightened again', straightened.room!.walls[0].bulge === undefined);
  check('back to where it started', sqft(straightened.room!) === 1200);

  const lengthened = setWallLength(room, 0, 50 * F);
  check('a wall length can be set', lengthened.ok, lengthened.reason);
  check(
    'keeping the start corner fixed',
    lengthened.ok &&
      lengthened.room!.walls[0].start.x === room.walls[0].start.x &&
      lengthened.room!.walls[0].start.y === room.walls[0].start.y,
  );
  check(
    'and extending the end',
    lengthened.ok && Math.abs(lengthened.room!.walls[0].end.x - room.walls[0].start.x - 50 * F) < 1e-6,
  );
  check('a curved wall refuses length edits', !setWallLength(bowed.room!, 0, 50 * F).ok);

  const byRadius = setWallRadius(room, 0, 30 * F);
  check('a wall can be curved by radius', byRadius.ok && !!byRadius.room!.walls[0].bulge, byRadius.reason);
  const major = setWallRadius(room, 0, 30 * F, true);
  check(
    'major arc takes the other bulge sign or magnitude',
    major.ok &&
      major.room!.walls[0].bulge !== undefined &&
      major.room!.walls[0].bulge !== byRadius.room!.walls[0].bulge,
    major.reason,
  );
}

{
  const open = { id: 'r', name: 'Open', walls: [wall({ x: 0, y: 0 }, { x: 100, y: 0 }), wall({ x: 100, y: 0 }, { x: 100, y: 100 }), wall({ x: 100, y: 100 }, { x: 50, y: 50 })], holes: [] };
  const problems = roomProblems(open);
  check('an unclosed outline is described, not thrown', problems.length > 0 && problems[0].includes('does not meet'), problems.join(' '));

  const stray = rectangularRoom(40 * F, 30 * F);
  stray.holes.push(rectRoom(200 * F, 200 * F, 5 * F, 5 * F).walls);
  check('a cut-out outside the room is reported', roomProblems(stray).some((p) => p.includes('outside')));
}

// ---------------------------------------------------------------------------
console.log('\ndrawing a room into a plan\n');

const FIXTURE = fixturePlanBuffer();

const wallCount = (doc: Parameters<typeof deriveRoom>[0]) =>
  [...walk(doc)].filter((n) => n.cls === 'RVSegmentLine' || n.cls === 'RVSegmentPoly').length;

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F, 'Ballroom');

  const drawn = applyRoom(doc, room);
  check('a new room is drawn', drawn.ok, drawn.reason);
  check('one object per wall', drawn.created === 4 && drawn.updated === 0, JSON.stringify(drawn));
  check('the plan now has four wall objects', wallCount(doc) === 4, `${wallCount(doc)}`);

  const verdict = verifyWritable(doc);
  check('the plan with a drawn room verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'drawn.rv4').document;
  const back = deriveRoom(reread);
  check('reopening the file finds the room', back.source === 'walls' && back.closed, back.source);
  check('at the right size', Math.round(toSquareFeet(roomArea(back.room))) === 1200);
}

{
  // The idempotence test: applying twice must not draw twice.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F, 'Ballroom');

  applyRoom(doc, room);
  const again = applyRoom(doc, room, room);
  check('drawing the same room again changes nothing', again.created === 0 && again.removed === 0, JSON.stringify(again));
  check('every wall was matched and left alone', again.updated === 4 && again.unmatched === 0, JSON.stringify(again));
  check('and the plan still has four wall objects', wallCount(doc) === 4, `${wallCount(doc)}`);
  check('it still verifies', verifyWritable(doc).ok);
}

{
  // Editing a room moves the drawn walls rather than adding new ones.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F, 'Ballroom');
  applyRoom(doc, room);

  const deeper = offsetWall(room, 1, 5 * F).room!;
  const moved = applyRoom(doc, deeper, room);
  check('an edited room updates the objects already there', moved.updated === 4, JSON.stringify(moved));
  check('nothing new was drawn', moved.created === 0 && moved.removed === 0);
  check('the plan still has four wall objects', wallCount(doc) === 4, `${wallCount(doc)}`);

  const verdict = verifyWritable(doc);
  check('the edited plan verifies', verdict.ok, verdict.reason);
  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'edited.rv4').document;
  check(
    'and reopens at the new size',
    Math.round(toSquareFeet(roomArea(deriveRoom(reread).room))) === 1200 + 150,
    `${Math.round(toSquareFeet(roomArea(deriveRoom(reread).room)))}`,
  );
}

{
  // Losing a corner removes the object that drew it.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = addCorner(rectangularRoom(40 * F, 30 * F), 0).room!;
  applyRoom(doc, room);
  check('a five-walled room draws five objects', wallCount(doc) === 5, `${wallCount(doc)}`);

  const simpler = removeCorner(room, 1).room!;
  const applied = applyRoom(doc, simpler, room);
  check('removing a corner removes an object', applied.removed >= 1, JSON.stringify(applied));
  check('leaving four', wallCount(doc) === 4, `${wallCount(doc)}`);
  check('and it verifies', verifyWritable(doc).ok);
}

{
  // A curved wall changes point count, so it is replaced rather than moved.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F);
  applyRoom(doc, room);

  const bowed = curveWall(room, 0, 0.3).room!;
  const applied = applyRoom(doc, bowed, room);
  check('curving a wall replaces its object', applied.created === 1 && applied.removed === 1, JSON.stringify(applied));
  check('the other three were moved', applied.updated === 3, JSON.stringify(applied));

  const verdict = verifyWritable(doc);
  check('a plan with a curved wall verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'curved.rv4').document;
  const polylines = [...walk(reread)].filter((n) => n.cls === 'RVSegmentPoly');
  check('the curve was written as a polyline', polylines.length === 1, `${polylines.length}`);
  check('with more than two points', polylines[0].points.length > 2, `${polylines[0]?.points.length}`);
}

{
  // A plan edited elsewhere: the previous model no longer matches, and that is
  // reported instead of silently duplicating the room.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F);
  const stale = rectangularRoom(99 * F, 99 * F);
  const applied = applyRoom(doc, room, stale);
  check('walls that cannot be found are counted', applied.unmatched === 4, JSON.stringify(applied));
  check('and the room is drawn fresh rather than half-updated', applied.created === 4);
  check('the plan verifies', verifyWritable(doc).ok);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
