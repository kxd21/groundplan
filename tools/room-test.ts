/**
 * The foundation phase: units, the room model, and the companion document.
 *
 * These three are tested together because they only mean anything together —
 * a room is measured in units and stored in a companion, and the companion is
 * only trustworthy if it can tell when it has gone stale.
 *
 *   npx tsx tools/room-test.ts
 */

import { loadBuffer, UNITS_PER_FOOT, type RVDocument } from '../src/format/index.js';
import { packContainer, verifyWritable } from '../src/format/write.js';
import { addRoot, appendChild } from '../src/format/edit.js';
import { createContainer, createSegment } from '../src/format/synthesize.js';
import {
  allCapacities,
  arcOf,
  circularRoom,
  containsPoint,
  deriveRoom,
  describeRoom,
  isClosed,
  rectangularHole,
  rectangularRoom,
  roomArea,
  roomBounds,
  roomCapacity,
  roomFromPolygon,
  roomPerimeter,
  wall,
  wallLength,
  type RoomModel,
} from '../src/format/room.js';
import {
  companionStatus,
  createCompanion,
  companionPathFor,
  parseCompanion,
} from '../src/format/companion.js';
import {
  coarseStep,
  formatArea,
  formatLength,
  parseLength,
  toSquareFeet,
  UNITS_PER_METRE,
} from '../src/format/units.js';
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

// ---------------------------------------------------------------------------
console.log('units\n');

check('feet and inches parse together', parseLength("12' 6\"") === 12 * 120 + 6 * 10);
check('the inch mark is optional', parseLength("12'6") === 12 * 120 + 6 * 10);
check('whole feet parse', parseLength("40'") === 4800);
check('inches alone parse', parseLength('66"') === 660);
check('written units parse', parseLength('12 ft 6 in') === 12 * 120 + 6 * 10);
check('a bare number is feet in imperial', parseLength('40') === 4800);
check('a bare number is metres in metric', near(parseLength('4', 'metric')!, 4 * UNITS_PER_METRE));
check('metres parse', near(parseLength('3.6m')!, 3.6 * UNITS_PER_METRE));
check('centimetres parse', near(parseLength('360cm')!, 3.6 * UNITS_PER_METRE));
check('millimetres parse', near(parseLength('3600mm')!, 3.6 * UNITS_PER_METRE, 1e-9));
check('a negative length parses', parseLength("-12'") === -1440);
check('nonsense is refused rather than guessed', parseLength('about a metre') === null);
check('an empty box is refused', parseLength('   ') === null);

check('whole feet print without inches', formatLength(4800) === "40'");
check('feet and inches print', formatLength(4800 + 60) === `40' 6"`);
check('inches alone print', formatLength(60) === '6"');
check(
  'rounding carries into the next foot',
  formatLength(1440 - 0.4) === "12'",
  formatLength(1440 - 0.4),
);
check('metric prints metres', formatLength(UNITS_PER_METRE * 3.6, 'metric') === '3.60 m');
check('metric prints small lengths in centimetres', formatLength(UNITS_PER_METRE * 0.5, 'metric').endsWith('cm'));
check('an area prints in square feet', formatArea(4800 * 3600) === '1,200 sq ft');
check('an area prints in square metres', formatArea(4800 * 3600, 'metric').endsWith('m²'));
check('the coarse step is a foot in imperial', coarseStep('imperial') === UNITS_PER_FOOT);

// A measurement typed, stored, and shown must come back in normal form: the
// same length, written the way a plan is dimensioned.
for (const [typed, shown] of [
  ["40'", "40'"],
  ["12' 6\"", "12' 6\""],
  ['66"', "5' 6\""],
  ["8' 3\"", "8' 3\""],
  ['150"', "12' 6\""],
] as const) {
  const units = parseLength(typed)!;
  check(`${typed} normalises to ${shown}`, formatLength(units) === shown, formatLength(units));
}

// ---------------------------------------------------------------------------
console.log('\nroom geometry\n');

{
  const room = rectangularRoom(40 * UNITS_PER_FOOT, 30 * UNITS_PER_FOOT, 'Ballroom');
  check('a rectangular room has four walls', room.walls.length === 4);
  check('it is closed', isClosed(room.walls));
  check('its area is 1,200 sq ft', Math.round(toSquareFeet(roomArea(room))) === 1200);
  check('its perimeter is 140 ft', Math.round(roomPerimeter(room) / UNITS_PER_FOOT) === 140);
  check('a point inside is inside', containsPoint(room, { x: 100, y: 100 }));
  check('a point outside is outside', !containsPoint(room, { x: -100, y: 100 }));
  check('it describes itself', describeRoom(room) === '40 x 30 ft, 1,200 sq ft', describeRoom(room));
}

{
  // The case a bounding box gets wrong: an L-shaped room. The box says 1,200
  // sq ft; the room is 900.
  const f = UNITS_PER_FOOT;
  const room = roomFromPolygon(
    [
      { x: 0, y: 0 },
      { x: 40 * f, y: 0 },
      { x: 40 * f, y: 15 * f },
      { x: 20 * f, y: 15 * f },
      { x: 20 * f, y: 30 * f },
      { x: 0, y: 30 * f },
    ],
    'L-shaped hall',
  );
  const bounds = roomBounds(room)!;
  const boxArea = toSquareFeet((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
  check('the bounding box over-reports an L-shaped room', Math.round(boxArea) === 1200);
  check('the room model reports the real 900 sq ft', Math.round(toSquareFeet(roomArea(room))) === 900);
  check('a point in the missing corner is outside', !containsPoint(room, { x: 30 * f, y: 25 * f }));
}

{
  // Holes: a structural column removes floor from the count.
  const f = UNITS_PER_FOOT;
  const room = rectangularRoom(40 * f, 30 * f, 'Ballroom');
  room.holes.push(rectangularHole(10 * f, 10 * f, 4 * f, 4 * f));
  check('a column removes its floor area', Math.round(toSquareFeet(roomArea(room))) === 1200 - 16);
  check('a point inside the column is not in the room', !containsPoint(room, { x: 12 * f, y: 12 * f }));
}

{
  // Curves. A semicircular bay: chord 100, bulge 1.
  const segment = wall({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
  const arc = arcOf(segment)!;
  check('a bulge of 1 is a half circle', near(arc.radius, 50) && near(Math.abs(arc.sweep), Math.PI));
  check('its centre is the chord midpoint', near(arc.centre.x, 50) && near(arc.centre.y, 0, 1e-9));
  check('its length is pi r', near(wallLength(segment), Math.PI * 50, 1e-6));

  const shallow = wall({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.1);
  const shallowArc = arcOf(shallow)!;
  // Sagitta of a bulge is b x half-chord, so 0.1 x 50 = 5.
  const apexAngle = shallowArc.startAngle + shallowArc.sweep / 2;
  const apex = {
    x: shallowArc.centre.x + shallowArc.radius * Math.cos(apexAngle),
    y: shallowArc.centre.y + shallowArc.radius * Math.sin(apexAngle),
  };
  check('a shallow arc bows by its sagitta', near(Math.abs(apex.y), 5, 1e-6), `${apex.y}`);
  check('a shallow arc starts where it should', near(apex.x, 50, 1e-6));
  check('an arc is longer than its chord', wallLength(shallow) > 100);
  check('a straight run has no arc', arcOf(wall({ x: 0, y: 0 }, { x: 100, y: 0 })) === null);

  // A round room built from four quarter-circle walls: area should be pi r^2.
  const r = 100;
  const q = Math.tan(Math.PI / 8); // bulge of a quarter circle
  const round: RoomModel = {
    id: 'round',
    name: 'Rotunda',
    walls: [
      wall({ x: r, y: 0 }, { x: 0, y: r }, q),
      wall({ x: 0, y: r }, { x: -r, y: 0 }, q),
      wall({ x: -r, y: 0 }, { x: 0, y: -r }, q),
      wall({ x: 0, y: -r }, { x: r, y: 0 }, q),
    ],
    holes: [],
  };
  const area = roomArea(round);
  check(
    'a round room measures pi r squared exactly, not to a flattening tolerance',
    Math.abs(area - Math.PI * r * r) < 1e-6,
    `${area} vs ${Math.PI * r * r}`,
  );
  check(
    'its perimeter is 2 pi r',
    Math.abs(roomPerimeter(round) - 2 * Math.PI * r) < 0.01,
    `${roomPerimeter(round)}`,
  );

  const authored = circularRoom(2 * r, 'Rotunda', { x: 25, y: 50 });
  const authoredBounds = roomBounds(authored)!;
  check('the circular-room constructor keeps four exact curved walls', authored.walls.length === 4 && authored.walls.every((run) => !!run.bulge));
  check('a circular room is positioned from its top-left bounds',
    near(authoredBounds.minX, 25) && near(authoredBounds.minY, 50) && near(authoredBounds.maxX, 25 + 2 * r) && near(authoredBounds.maxY, 50 + 2 * r));
  check('the circular-room constructor has exact area and perimeter',
    near(roomArea(authored), Math.PI * r * r) && near(roomPerimeter(authored), 2 * Math.PI * r));
}

// ---------------------------------------------------------------------------
console.log('\ncapacity\n');

{
  const room = rectangularRoom(40 * UNITS_PER_FOOT, 30 * UNITS_PER_FOOT, 'Ballroom');
  const theatre = roomCapacity(room, 'theatre');
  check('1,200 sq ft seats 150-200 theatre style', theatre.low === 150 && theatre.high === 200, JSON.stringify(theatre));

  const banquet = roomCapacity(room, 'banquet');
  check('the same room seats fewer at rounds', banquet.high < theatre.low, JSON.stringify(banquet));

  room.reservedArea = 400 * UNITS_PER_FOOT * UNITS_PER_FOOT;
  const afterStage = roomCapacity(room, 'theatre');
  check('reserving floor for a stage lowers the count', afterStage.high < theatre.high);

  check('every layout is offered', allCapacities(room).length === 8);
}

// ---------------------------------------------------------------------------
console.log('\nderiving a room from a plan\n');

const FIXTURE = fixturePlanBuffer({ walls: false });

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const derived = deriveRoom(doc);
  check(
    'a plan with no walls falls back to the extent, and says so',
    derived.source === 'extent' && !derived.closed,
    derived.source,
  );
}

{
  // A plan whose walls were built from scratch, then read back and recovered
  // as a room — the whole foundation, end to end.
  const doc: RVDocument = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const f = UNITS_PER_FOOT;
  const walls = createContainer(doc, { cls: 'RVWalls' });
  const corners: Array<[number, number, number, number]> = [
    [0, 0, 40 * f, 0],
    [40 * f, 0, 40 * f, 30 * f],
    [40 * f, 30 * f, 0, 30 * f],
    [0, 30 * f, 0, 0],
  ];
  for (const [x1, y1, x2, y2] of corners) {
    const seg = createSegment(doc, {
      cls: 'RVSegmentLine',
      points: [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
    });
    appendChild(doc, walls.node!, seg.node!);
  }
  addRoot(doc, walls.node!);

  const verdict = verifyWritable(doc);
  check('a plan with synthesized walls verifies', verdict.ok, verdict.reason);

  const derived = deriveRoom(doc);
  check('the walls are recognised as the room boundary', derived.source === 'walls', derived.source);
  check('the boundary closed', derived.closed);
  check('the derived room is 1,200 sq ft', Math.round(toSquareFeet(roomArea(derived.room))) === 1200);
  check('the derived room has four walls', derived.room.walls.length === 4);
  check(
    'its capacity follows',
    roomCapacity(derived.room, 'theatre').high === 200,
    JSON.stringify(roomCapacity(derived.room, 'theatre')),
  );
}

// ---------------------------------------------------------------------------
console.log('\ncompanion document\n');

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * UNITS_PER_FOOT, 30 * UNITS_PER_FOOT, 'Ballroom');
  room.holes.push(rectangularHole(120, 120, 480, 480));
  room.ceilingHeight = 16 * UNITS_PER_FOOT;

  const companion = createCompanion(doc, 'imperial', [room]);
  // Appended, not substituted, so Plan.rv4 and Plan.rs4 cannot collide — and
  // so it matches the schedule sidecar this app already writes.
  check(
    'the sidecar sits beside the plan',
    companionPathFor('/x/Spring Gala.rv4') === '/x/Spring Gala.rv4.groundplan.json',
    companionPathFor('/x/Spring Gala.rv4'),
  );
  check('a fresh companion matches its plan', companionStatus(companion, doc).freshness === 'fresh');

  const round = parseCompanion(JSON.parse(JSON.stringify(companion)));
  check('a companion survives being written and read', !!round);
  check('the room comes back whole', round!.rooms.length === 1 && round!.rooms[0].walls.length === 4);
  check('the hole comes back', round!.rooms[0].holes.length === 1);
  check('the ceiling height comes back', round!.rooms[0].ceilingHeight === 16 * UNITS_PER_FOOT);
  check(
    'the area is unchanged by the round trip',
    Math.round(roomArea(round!.rooms[0])) === Math.round(roomArea(room)),
  );

  // Staleness: the plan changed underneath the companion.
  const edited = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const seg = createSegment(edited, { cls: 'RVSegmentLine', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
  addRoot(edited, seg.node!);
  const rewritten = verifyWritable(edited);
  const reopened = loadBuffer(packContainer(FIXTURE, rewritten.bytes!), 'edited.rv4').document;
  const status = companionStatus(companion, reopened);
  check('a companion notices its plan was edited elsewhere', status.freshness === 'stale', status.freshness);
  check('and explains it in words a user can act on', !!status.reason && status.reason.includes('Room Viewer'));
  check('a missing companion is missing, not stale', companionStatus(null, doc).freshness === 'missing');

  // Damaged and future files must not be half-applied.
  check('a companion from a later version is refused', parseCompanion({ ...companion, version: 99 }) === null);
  check('a foreign file is refused', parseCompanion({ format: 'something-else' }) === null);
  check('nonsense is refused', parseCompanion('not an object') === null);
  check(
    'a companion with a corrupt digest is refused',
    parseCompanion({ ...companion, plan: { ...companion.plan, digest: 'zzz' } }) === null,
  );
  const partial = JSON.parse(JSON.stringify(companion));
  partial.rooms[0].walls[1].start = { x: 'x', y: 0 };
  const salvaged = parseCompanion(partial);
  check('a room with one bad wall keeps the walls it can read', salvaged!.rooms[0].walls.length === 3);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
