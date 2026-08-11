/**
 * Curve authoring: entering an arc the way it gets described out loud.
 *
 *   npx tsx tools/curve-test.ts
 */

import { loadBuffer, walk, UNITS_PER_FOOT } from '../src/format/index.js';
import { packContainer, verifyWritable } from '../src/format/write.js';
import {
  bulgeFromAngle,
  bulgeFromArcLength,
  bulgeFromRadius,
  bulgeFromSagitta,
  bulgeFromTangent,
  bulgeThroughPoint,
  CURVE_PRESETS,
  exitDirection,
  readCurve,
  snapAngle,
  snapRadius,
} from '../src/format/curve.js';
import {
  fitWallThroughPoint,
  makeWallTangent,
  setWallAngle,
  setWallArcLength,
  setWallRadius,
  setWallSagitta,
} from '../src/format/room-edit.js';
import { arcOf, flattenWall, rectangularRoom, roomArea, wall, wallLength } from '../src/format/room.js';
import { applyRoom } from '../src/format/room-render.js';
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

const near = (a: number, b: number, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const F = UNITS_PER_FOOT;

// ---------------------------------------------------------------------------
console.log('entering a curve\n');

{
  // Radius. A 100-unit chord on a 50 radius is exactly a half circle.
  check('a radius equal to half the chord is a half circle', near(bulgeFromRadius(100, 50)!, 1));
  check('a bigger radius is a shallower arc', bulgeFromRadius(100, 200)! < bulgeFromRadius(100, 100)!);
  check('a negative radius bows the other way', bulgeFromRadius(100, -200)! < 0);
  check('the long way round bows further', bulgeFromRadius(100, 200, true)! > 1);
  check('a radius too small to reach is refused', bulgeFromRadius(100, 40) === null);

  // Round trip: set a radius, read it back.
  const w = wall({ x: 0, y: 0 }, { x: 40 * F, y: 0 }, bulgeFromRadius(40 * F, 30 * F)!);
  check('a 30 ft radius reads back as 30 ft', near(readCurve(w).radius! / F, 30, 1e-6), `${readCurve(w).radius! / F}`);
}

{
  // Sagitta — "it bows out 18 inches".
  const chord = 40 * F;
  const bulge = bulgeFromSagitta(chord, 18 * 10)!;
  const w = wall({ x: 0, y: 0 }, { x: chord, y: 0 }, bulge);
  check('a bow of 18in reads back as 18in', near(readCurve(w).sagitta / 10, 18, 1e-9), `${readCurve(w).sagitta / 10}`);
  check('a straight wall bows zero', bulgeFromSagitta(chord, 0) === 0);
}

{
  // Included angle.
  check('90 degrees is a quarter round', near(bulgeFromAngle(90)!, Math.tan(Math.PI / 8)));
  check('180 degrees is a half round', near(bulgeFromAngle(180)!, 1));
  check('a full circle between two points is refused', bulgeFromAngle(360) === null);

  const w = wall({ x: 0, y: 0 }, { x: 100, y: 0 }, bulgeFromAngle(90)!);
  check('the angle reads back', near(readCurve(w).angle, 90, 1e-9), `${readCurve(w).angle}`);
}

{
  // Arc length — how a curved wall is quoted by the shop.
  const chord = 40 * F;
  const bulge = bulgeFromArcLength(chord, 50 * F)!;
  const w = wall({ x: 0, y: 0 }, { x: chord, y: 0 }, bulge);
  check('a 50 ft run across a 40 ft chord measures 50 ft', near(wallLength(w) / F, 50, 1e-6), `${wallLength(w) / F}`);
  check('a run equal to the chord is straight', bulgeFromArcLength(chord, chord) === 0);
  check('a run shorter than the chord is refused', bulgeFromArcLength(chord, chord - 1) === null);
}

{
  // Three points — tracing a curve off a survey.
  const a = { x: 0, y: 0 };
  const c = { x: 100, y: 0 };
  const through = { x: 50, y: -20 };
  const bulge = bulgeThroughPoint(a, through, c)!;
  const w = wall(a, c, bulge);
  const arc = arcOf(w)!;
  const distance = Math.hypot(through.x - arc.centre.x, through.y - arc.centre.y);
  check('an arc through three points passes through the middle one', near(distance, arc.radius, 1e-6), `${distance} vs ${arc.radius}`);
  // Sagitta is signed by the bulge, not by world y: bowing toward -y across a
  // left-to-right chord is the positive direction.
  check('it bows by the depth of that point', near(readCurve(w).sagitta, 20, 1e-6), `${readCurve(w).sagitta}`);
  check('three points in a line make a straight wall', bulgeThroughPoint(a, { x: 50, y: 0 }, c) === 0);

  const other = wall(a, c, bulgeThroughPoint(a, { x: 50, y: 20 }, c)!);
  check('a point on the other side bows the other way', readCurve(other).sagitta < 0);

  // The major arc: a point beyond the circle's widest span must come back as
  // the long way round, which is where a side-length test gets it wrong.
  const major = wall(a, c, bulgeThroughPoint(a, { x: 50, y: -120 }, c)!);
  check('a deep point gives the major arc', Math.abs(readCurve(major).angle) > 180, `${readCurve(major).angle}`);
  const majorArc = arcOf(major)!;
  check(
    'and it still passes through the point',
    near(Math.hypot(50 - majorArc.centre.x, -120 - majorArc.centre.y), majorArc.radius, 1e-6),
  );
}

{
  // Tangent continuation — the join people notice.
  const first = wall({ x: 0, y: 0 }, { x: 100, y: 0 });
  const bulge = bulgeFromTangent({ x: 100, y: 0 }, { x: 150, y: 50 }, exitDirection(first))!;
  const curved = wall({ x: 100, y: 0 }, { x: 150, y: 50 }, bulge);
  const arc = arcOf(curved)!;
  // Tangent at the start of the arc must be parallel to the wall before it.
  const tangent = { x: -Math.sin(arc.startAngle) * Math.sign(arc.sweep), y: Math.cos(arc.startAngle) * Math.sign(arc.sweep) };
  check('a tangent arc leaves flush with the wall before it', near(Math.abs(tangent.y), 0, 1e-9), JSON.stringify(tangent));
  check('and heads the same way', tangent.x > 0);

  // A curve's own exit direction continues the curve, not its chord.
  const exit = exitDirection(curved);
  check('a curve exits along its tangent', Math.abs(exit.x) + Math.abs(exit.y) > 0);
}

{
  check('a radius snaps to the foot', snapRadius(24 * F + 37, F) === 24 * F);
  check('an angle snaps to 15 degrees', near(snapAngle(bulgeFromAngle(88)!, 15), bulgeFromAngle(90)!, 1e-9));
  check('a straight wall stays straight when snapped', snapAngle(0) === 0);
  check('every preset is a usable bulge', CURVE_PRESETS.every((p) => Number.isFinite(p.bulge)));
}

// ---------------------------------------------------------------------------
console.log('\ncurving a room\n');

{
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  const flat = roomArea(room);

  const bowed = setWallRadius(room, 0, 30 * F);
  check('a wall takes a radius', bowed.ok, bowed.reason);
  check('which changes the floor area', roomArea(bowed.room!) !== flat);
  check('and reads back', near(readCurve(bowed.room!.walls[0]).radius! / F, 30, 1e-6));

  const tooTight = setWallRadius(room, 0, 5 * F);
  check('a radius that cannot reach is refused', !tooTight.ok);
  check('with a reason naming the wall length', (tooTight.reason ?? '').includes('40 ft'), tooTight.reason);

  check('a wall takes a bow depth', setWallSagitta(room, 1, 18 * 10).ok);
  check('a wall takes an angle', setWallAngle(room, 2, 45).ok);
  check('a wall takes a run length', setWallArcLength(room, 3, 35 * F).ok);
  check(
    'a wall takes a point to pass through',
    fitWallThroughPoint(room, 0, { x: 20 * F, y: -3 * F }).ok,
  );

  const tangent = makeWallTangent(room, 1);
  check('a wall can be made tangent to the one before it', tangent.ok, tangent.reason);
}

{
  // A bay window: a shallow arc on one wall, measured exactly.
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  const bay = setWallSagitta(room, 2, 4 * F).room!;
  // Segment area of the bow, added to the rectangle.
  const chord = 40 * F;
  const readout = readCurve(bay.walls[2]);
  const expected = 1200 + toSquareFeet((readout.radius! ** 2 * (Math.abs(readout.angle) * Math.PI / 180 - Math.sin(Math.abs(readout.angle) * Math.PI / 180))) / 2);
  check(
    'a 4 ft bay adds exactly its circular segment',
    Math.abs(toSquareFeet(roomArea(bay)) - expected) < 0.01,
    `${toSquareFeet(roomArea(bay))} vs ${expected}`,
  );
  void chord;
}

// ---------------------------------------------------------------------------
console.log('\ndrawing a curve into a plan\n');

const FIXTURE = fixturePlanBuffer();

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  const curved = setWallRadius(room, 0, 40 * F).room!;

  const drawn = applyRoom(doc, curved);
  check('a curved room draws', drawn.ok && drawn.created === 4, JSON.stringify(drawn));

  const verdict = verifyWritable(doc);
  check('it verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'curved.rv4').document;
  const polys = [...walk(reread)].filter((n) => n.cls === 'RVSegmentPoly');
  check('the curve became a polyline', polys.length === 1, `${polys.length}`);

  // The drawn polyline must track the true arc to within the stated tolerance.
  const exact = flattenWall(curved.walls[0], 0.1);
  const drawnPoints = polys[0].points;
  check('with the same number of points as the model flattened to', drawnPoints.length === exact.length, `${drawnPoints.length} vs ${exact.length}`);
  const worst = drawnPoints.reduce(
    (max, p, i) => Math.max(max, Math.hypot(p.x - exact[i].x, p.y - exact[i].y)),
    0,
  );
  check('and landing on the arc exactly', worst < 1e-9, `${worst}`);

  const arc = arcOf(curved.walls[0])!;
  const offCurve = drawnPoints.reduce(
    (max, p) => Math.max(max, Math.abs(Math.hypot(p.x - arc.centre.x, p.y - arc.centre.y) - arc.radius)),
    0,
  );
  check('every drawn point is on the true circle', offCurve < 1e-6, `${offCurve}`);
}

{
  // Regression: an outward (negative-bulge) bay must not walk backward past the
  // start corner. That bug drew the triangular spur when dragging a curve out.
  const start = { x: -9476.84376918993, y: 1302.9954624852753 };
  const end = { x: -1937.8567412322964, y: 353.7230055787046 };
  const bulge = -0.3911290107505649;
  const segment = wall(start, end, bulge);
  const curved = { ...segment, start, end, bulge };
  const flat = flattenWall(curved, 0.1);
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  const chordDir = { x: (end.x - start.x) / chord, y: (end.y - start.y) / chord };
  const ts = flat.map((p) => (p.x - start.x) * chordDir.x + (p.y - start.y) * chordDir.y);
  const arc = arcOf(curved)!;
  const endAngle = Math.atan2(end.y - arc.centre.y, end.x - arc.centre.x);
  const angleErr = Math.abs(
    ((((arc.startAngle + arc.sweep - endAngle) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
  );
  check('an inward bay does not spur past its start corner', Math.min(...ts) >= -1e-6, `${Math.min(...ts)}`);
  check('and its sweep lands on the end point', angleErr < 1e-9, `${angleErr}`);

  const rect = rectangularRoom(40 * F, 30 * F);
  const top = rect.walls[0]!;
  const topChord = Math.hypot(top.end.x - top.start.x, top.end.y - top.start.y);
  const topMid = { x: (top.start.x + top.end.x) / 2, y: (top.start.y + top.end.y) / 2 };
  const topOut = {
    x: (top.end.y - top.start.y) / topChord,
    y: -(top.end.x - top.start.x) / topChord,
  };
  const through = { x: topMid.x + topOut.x * 12 * F, y: topMid.y + topOut.y * 12 * F };
  const bay = fitWallThroughPoint(rect, 0, through);
  check('dragging a bay outward succeeds', bay.ok, bay.reason);
  if (bay.ok && bay.room) {
    const pts = flattenWall(bay.room.walls[0]!, 0.1);
    const w0 = bay.room.walls[0]!;
    const c = Math.hypot(w0.end.x - w0.start.x, w0.end.y - w0.start.y);
    const dir = { x: (w0.end.x - w0.start.x) / c, y: (w0.end.y - w0.start.y) / c };
    const along = pts.map((p) => (p.x - w0.start.x) * dir.x + (p.y - w0.start.y) * dir.y);
    check('an outward bay has no start-corner spur', Math.min(...along) >= -1e-6, `${Math.min(...along)}`);
    check('and keeps a positive (outward) bulge', (w0.bulge ?? 0) > 0, `${w0.bulge}`);
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
