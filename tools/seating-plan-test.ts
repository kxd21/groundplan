/**
 * Parametric seating: a layout that survives being changed.
 *
 *   npx tsx tools/seating-plan-test.ts
 */

import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import {
  compareLayouts,
  createSeatingPlan,
  resolveSeating,
  seatingCapacity,
  reservedFromObstacles,
  solveOptimum,
  solveSeating,
  STYLE_DEFAULTS,
  type SeatingStyle,
} from '../src/format/seating-plan.js';
import { rectangularRoom, rectangularHole, roomFromPolygon, containsPoint } from '../src/format/room.js';
import { combineRooms, rectRoom, setWallRadius } from '../src/format/room-edit.js';
import { renderSeating } from '../src/format/seating-render.js';
import { indexDocument } from '../src/format/edit.js';
import { loadBuffer, walk } from '../src/format/index.js';
import { packContainer, verifyWritable } from '../src/format/write.js';
import { fixturePlanBuffer } from './test-fixture.js';
import { createBlankPlan } from '../src/format/blank.js';
import { deriveRoom } from '../src/format/room.js';

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

function seatBox(seat: { x: number; y: number; rotation: number }, width: number, depth: number) {
  const cos = Math.abs(Math.cos(seat.rotation));
  const sin = Math.abs(Math.sin(seat.rotation));
  const halfW = (width * cos + depth * sin) / 2;
  const halfD = (width * sin + depth * cos) / 2;
  return { minX: seat.x - halfW, minY: seat.y - halfD, maxX: seat.x + halfW, maxY: seat.y + halfD };
}

function boxesOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
) {
  return a.maxX > b.minX && a.minX < b.maxX && a.maxY > b.minY && a.minY < b.maxY;
}

const F = UNITS_PER_FOOT;
/** A 60 x 40 ballroom with the stage at the top. */
const hall = () => rectangularRoom(60 * F, 40 * F, 'Ballroom');
const stage = { x: 30 * F, y: -6 * F };

// ---------------------------------------------------------------------------
console.log('every layout produces something usable\n');

{
  const room = hall();
  for (const style of Object.keys(STYLE_DEFAULTS) as SeatingStyle[]) {
    const solution = solveSeating(createSeatingPlan(style, stage), room);
    const produced = solution.seats.length + solution.tables.length;
    check(`${style} lays out`, produced > 0, `${solution.seats.length} seats, ${solution.tables.length} tables`);
    check(
      `${style} keeps every seat inside the room`,
      solution.seats.every((s) => containsPoint(room, { x: s.x, y: s.y })),
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nthe numbers respond to the parameters\n');

{
  const room = hall();
  const base = createSeatingPlan('theatre', stage);
  const seats = seatingCapacity(base, room);
  check('a 2,400 sq ft hall seats a sensible number theatre style', seats > 250 && seats < 900, `${seats}`);

  const roomier = seatingCapacity({ ...base, rowSpacing: base.rowSpacing * 1.5 }, room);
  check('wider rows seat fewer', roomier < seats, `${roomier} vs ${seats}`);

  const tighter = seatingCapacity({ ...base, seatSpacing: base.seatSpacing * 0.8 }, room);
  check('narrower seats seat more', tighter > seats, `${tighter} vs ${seats}`);

  const withAisle = seatingCapacity(
    { ...base, clearances: { ...base.clearances, centreAisle: 6 * F } },
    room,
  );
  check('a centre aisle costs seats', withAisle < seats, `${withAisle} vs ${seats}`);

  const crossAisles = seatingCapacity(
    { ...base, clearances: { ...base.clearances, rowsPerBlock: 5, aisle: 6 * F } },
    room,
  );
  check('cross aisles cost seats too', crossAisles < seats, `${crossAisles} vs ${seats}`);

  const pushedBack = seatingCapacity(
    { ...base, clearances: { ...base.clearances, front: 20 * F } },
    room,
  );
  check('a deeper front clearance costs seats', pushedBack < seats, `${pushedBack} vs ${seats}`);

  const capped = seatingCapacity({ ...base, maxSeats: 100 }, room);
  check('a seat cap is honoured', capped === 100, `${capped}`);
}

{
  // Stagger must not change the count much, but must move the seats.
  const room = hall();
  const straight = solveSeating({ ...createSeatingPlan('theatre', stage), stagger: false }, room);
  const staggered = solveSeating({ ...createSeatingPlan('theatre', stage), stagger: true }, room);
  const rowOf = (s: typeof straight, row: number) => s.seats.filter((x) => x.row === row).map((x) => x.x).sort((a, b) => a - b);
  check('staggering offsets alternate rows', rowOf(staggered, 1)[0] !== rowOf(straight, 1)[0]);
  check('but not the first row', Math.abs(rowOf(staggered, 0)[0] - rowOf(straight, 0)[0]) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log('\nseats face the stage\n');

{
  const room = hall();
  const solution = solveSeating(createSeatingPlan('theatre-curved', stage), room);
  check('a curved layout produces seats', solution.seats.length > 100, `${solution.seats.length}`);

  // Every seat's rotation must point at the focus, allowing for the quarter
  // turn a chair outline carries.
  const worst = solution.seats.reduce((max, s) => {
    const wanted = Math.atan2(stage.y - s.y, stage.x - s.x) + Math.PI / 2;
    let error = s.rotation - wanted;
    while (error > Math.PI) error -= 2 * Math.PI;
    while (error < -Math.PI) error += 2 * Math.PI;
    return Math.max(max, Math.abs(error));
  }, 0);
  check('every seat faces the stage exactly', worst < 1e-9, `${worst}`);

  // Rows must be evenly spaced from the stage.
  const radii = [0, 1, 2].map((row) => {
    const seat = solution.seats.find((s) => s.row === row)!;
    return Math.hypot(seat.x - stage.x, seat.y - stage.y);
  });
  const plan = createSeatingPlan('theatre-curved', stage);
  check(
    'curved rows sit one row spacing apart',
    Math.abs(radii[1] - radii[0] - plan.rowSpacing) < 1e-6 && Math.abs(radii[2] - radii[1] - plan.rowSpacing) < 1e-6,
    radii.join(', '),
  );
  check('and the first row clears the stage', Math.abs(radii[0] - plan.clearances.front) < 1e-6, `${radii[0]}`);
}

{
  const room = hall();
  const chevron = createSeatingPlan('chevron', stage);
  chevron.sections = [
    { splay: -30, gap: 2 * F },
    { splay: 0, gap: 0 },
    { splay: 30, gap: 2 * F },
  ];
  const solution = solveSeating(chevron, room);
  check('a chevron produces three banks', new Set(solution.seats.map((s) => s.section)).size === 3);
  check('all of them inside the room', solution.seats.every((s) => containsPoint(room, { x: s.x, y: s.y })));
  check('and every seat still faces the stage', solution.seats.length > 100, `${solution.seats.length}`);
}

// ---------------------------------------------------------------------------
console.log('\nthe room shapes the seating\n');

{
  // An L-shaped hall: seats must not appear in the missing corner.
  const l = combineRooms(
    rectangularRoom(60 * F, 20 * F),
    rectRoom(0, 20 * F, 30 * F, 20 * F),
    'union',
  ).room!;
  const solution = solveSeating(createSeatingPlan('theatre', { x: 30 * F, y: -6 * F }), l);
  check('an L-shaped room lays out', solution.seats.length > 50, `${solution.seats.length}`);
  check('with nothing in the missing corner', solution.seats.every((s) => containsPoint(l, { x: s.x, y: s.y })));
  check('and it says how many it dropped', solution.dropped > 0 && solution.notes.some((n) => n.includes('outside')), solution.notes.join(' '));

  const rect = solveSeating(createSeatingPlan('theatre', { x: 30 * F, y: -6 * F }), rectangularRoom(60 * F, 40 * F));
  check('which is fewer than the same rectangle would hold', solution.seats.length < rect.seats.length);
}

{
  // A structural column.
  const room = hall();
  room.holes.push(rectangularHole(25 * F, 15 * F, 6 * F, 6 * F));
  const solution = solveSeating(createSeatingPlan('theatre', stage), room);
  check('nobody is seated inside a column', solution.seats.every((s) => containsPoint(room, { x: s.x, y: s.y })));
  check(
    'specifically not in the middle of it',
    !solution.seats.some((s) => s.x > 26 * F && s.x < 30 * F && s.y > 16 * F && s.y < 20 * F),
  );
}

{
  // Reserved floor: a dance floor and a bar.
  const room = hall();
  const plan = createSeatingPlan('banquet', stage);
  plan.reserved = [
    { x: 20 * F, y: 10 * F, width: 20 * F, height: 20 * F, label: 'Dance floor' },
  ];
  const solution = solveSeating(plan, room);
  check('tables avoid the dance floor', solution.tables.length > 0);
  check(
    'no table sits on it',
    !solution.tables.some((t) => t.x > 20 * F && t.x < 40 * F && t.y > 10 * F && t.y < 30 * F),
  );
  const without = solveSeating({ ...plan, reserved: [] }, room);
  check('and reserving floor costs tables', solution.tables.length < without.tables.length, `${solution.tables.length} vs ${without.tables.length}`);
}

{
  // A curved back wall.
  const room = setWallRadius(rectangularRoom(60 * F, 40 * F), 2, 50 * F).room!;
  const solution = solveSeating(createSeatingPlan('theatre', stage), room);
  check('a room with a curved wall lays out', solution.seats.length > 100, `${solution.seats.length}`);
  check('and respects the curve', solution.seats.every((s) => containsPoint(room, { x: s.x, y: s.y })));
}

// ---------------------------------------------------------------------------
console.log('\nrounds\n');

{
  const room = hall();
  const banquet = solveSeating(createSeatingPlan('banquet', stage), room);
  check('a banquet places tables', banquet.tables.length > 5, `${banquet.tables.length}`);
  check('with chairs all round each', banquet.tables.every((t) => t.seats === 8), banquet.tables.map((t) => t.seats).join(','));
  check('and every chair belongs to a table', banquet.seats.every((s) => s.table != null));
  check(
    'seats total the tables',
    banquet.seats.length === banquet.tables.reduce((n, t) => n + t.seats, 0),
  );

  const cabaret = solveSeating(createSeatingPlan('cabaret', stage), room);
  check('cabaret leaves the stage side open', cabaret.tables[0].seats < 8, `${cabaret.tables[0].seats}`);
  const crescent = solveSeating(createSeatingPlan('crescent', stage), room);
  check('a crescent seats fewer still', crescent.tables[0].seats <= cabaret.tables[0].seats, `${crescent.tables[0].seats}`);

  // Chairs face inward at the table they belong to.
  const table = banquet.tables[0];
  const chairs = banquet.seats.filter((s) => s.table === table.index);
  const worst = chairs.reduce((max, c) => {
    const wanted = Math.atan2(table.y - c.y, table.x - c.x) + Math.PI / 2;
    let error = c.rotation - wanted;
    while (error > Math.PI) error -= 2 * Math.PI;
    while (error < -Math.PI) error += 2 * Math.PI;
    return Math.max(max, Math.abs(error));
  }, 0);
  check('every chair faces its own table', worst < 1e-9, `${worst}`);

  const bigger = solveSeating(
    { ...createSeatingPlan('banquet', stage), tableDiameter: 72 * UNITS_PER_INCH, seatsPerTable: 10 },
    room,
  );
  check('bigger tables mean fewer of them', bigger.tables.length <= banquet.tables.length);
  check('but more seats each', bigger.tables[0].seats === 10);
}

// ---------------------------------------------------------------------------
console.log('\nfurniture footprints\n');

{
  const room = hall();
  const chairSize = 24 * UNITS_PER_INCH;
  const plan = {
    ...createSeatingPlan('theatre', stage),
    seatSpacing: 12 * UNITS_PER_INCH,
    rowSpacing: 18 * UNITS_PER_INCH,
    chairWidth: chairSize,
    chairDepth: chairSize,
    splay: 30,
  };
  const solution = solveSeating(plan, room);
  const boxes = solution.seats.map((seat) => seatBox(seat, chairSize, chairSize));
  let overlap = false;
  for (let i = 0; i < boxes.length && !overlap; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i]!, boxes[j]!)) {
        overlap = true;
        break;
      }
    }
  }
  check('selected chair size prevents chair-on-chair overlap', !overlap, `${solution.seats.length} chairs`);
  check('too-small spacing is explained', solution.notes.some((note) => /increased to prevent/i.test(note)));
}

{
  const room = hall();
  const chairSize = 18 * UNITS_PER_INCH;
  const baselinePlan = { ...createSeatingPlan('theatre', stage), chairWidth: chairSize, chairDepth: chairSize };
  const first = solveSeating(baselinePlan, room).seats[0]!;
  const reserved = {
    x: first.x + 8 * UNITS_PER_INCH,
    y: first.y - 2 * UNITS_PER_INCH,
    width: 4 * UNITS_PER_INCH,
    height: 4 * UNITS_PER_INCH,
  };
  const solution = solveSeating({ ...baselinePlan, reserved: [reserved] }, room);
  const reservedBox = {
    minX: reserved.x,
    minY: reserved.y,
    maxX: reserved.x + reserved.width,
    maxY: reserved.y + reserved.height,
  };
  check(
    'chair outlines avoid an object even when their center points miss it',
    solution.seats.every((seat) => !boxesOverlap(seatBox(seat, chairSize, chairSize), reservedBox)),
  );
}

{
  const plan = {
    ...createSeatingPlan('banquet', stage),
    chairWidth: 18 * UNITS_PER_INCH,
    chairDepth: 18 * UNITS_PER_INCH,
    seatsPerTable: 24,
  };
  const solution = solveSeating(plan, hall());
  check('chairs per round table is reduced before chairs overlap', solution.tables.every((table) => table.seats < 24));
  check('the reduced chair count is explained', solution.notes.some((note) => /Chairs per table reduced/.test(note)));
  check('table counts match the chairs actually placed', solution.seats.length === solution.tables.reduce((sum, table) => sum + table.seats, 0));
}

// ---------------------------------------------------------------------------
console.log('\nschoolroom, conference and perimeter\n');

{
  const room = hall();
  const school = solveSeating(createSeatingPlan('schoolroom', stage), room);
  check('schoolroom pairs a table with each row', school.tables.length === school.rowCount, `${school.tables.length} vs ${school.rowCount}`);
  check('the tables span their rows', school.tables.every((t) => (t.length ?? 0) > 0));

  const u = solveSeating(createSeatingPlan('u-shape', stage), room);
  const square = solveSeating(createSeatingPlan('hollow-square', stage), room);
  check('a U seats fewer than a closed square', u.seats.length < square.seats.length, `${u.seats.length} vs ${square.seats.length}`);

  const perimeter = solveSeating(createSeatingPlan('perimeter', stage), room);
  check('a perimeter run seats around the walls', perimeter.seats.length > 0);

  const reception = solveSeating(createSeatingPlan('reception', stage), room);
  check('a reception places cocktail tables and no chairs', reception.tables.length > 0 && reception.seats.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\nregenerating\n');

{
  const room = hall();
  const plan = createSeatingPlan('theatre', stage);

  const first = solveSeating(plan, room);
  const same = solveSeating(plan, room);
  check('solving twice gives the same answer', first.seats.length === same.seats.length);
  check(
    'seat for seat',
    first.seats.every((s, i) => s.x === same.seats[i].x && s.y === same.seats[i].y),
  );

  // Somebody nudges row 2 by hand, then widens the aisles.
  const adjusted: typeof first = {
    ...first,
    seats: first.seats.map((s) => (s.row === 2 ? { ...s, x: s.x + 100 } : s)),
  };
  const widened = { ...plan, rowSpacing: plan.rowSpacing * 1.2, lockedRows: [2] };
  const again = resolveSeating(widened, room, adjusted);

  const keptRow = again.seats.filter((s) => s.row === 2);
  const originalRow = adjusted.seats.filter((s) => s.row === 2);
  check('a locked row survives regeneration untouched', keptRow.length === originalRow.length);
  check(
    'with its hand adjustment intact',
    keptRow.every((s, i) => s.x === originalRow[i].x && s.y === originalRow[i].y),
  );
  check('and the change is announced', again.notes.some((n) => n.includes('locked')), again.notes.join(' '));

  const unlockedRow = again.seats.filter((s) => s.row === 3);
  const before = first.seats.filter((s) => s.row === 3);
  check('unlocked rows did move', unlockedRow[0].y !== before[0].y);
}

// ---------------------------------------------------------------------------
console.log('\ncomparing layouts\n');

{
  const room = hall();
  const table = compareLayouts(room, stage);
  check('every layout is compared', table.length === Object.keys(STYLE_DEFAULTS).length);
  check('sorted by capacity', table.every((row, i) => i === 0 || table[i - 1].seats >= row.seats));
  check('theatre beats banquet', table.find((r) => r.style === 'theatre')!.seats > table.find((r) => r.style === 'banquet')!.seats);

  const tiny = roomFromPolygon([
    { x: 0, y: 0 },
    { x: 8 * F, y: 0 },
    { x: 8 * F, y: 8 * F },
    { x: 0, y: 8 * F },
  ]);
  const cramped = compareLayouts(tiny, { x: 4 * F, y: -2 * F });
  check('a tiny room reports small numbers rather than failing', cramped.every((r) => r.seats < 40), JSON.stringify(cramped.slice(0, 3)));
}

{
  const room = hall();
  const bad = solveSeating({ ...createSeatingPlan('theatre', stage), seatSpacing: 0 }, room);
  check('zero spacing is refused rather than looping', bad.seats.length === 0 && bad.notes.length > 0, bad.notes.join(' '));
}

// ---------------------------------------------------------------------------
console.log('\ndrawing a layout into a plan\n');

{
  const FIXTURE = fixturePlanBuffer();
  const loaded = loadBuffer(FIXTURE, 'fixture.rv4');
  const doc = loaded.document;
  const room = hall();

  const plan = createSeatingPlan('theatre', stage);
  plan.maxSeats = 40;
  const solution = solveSeating(plan, room);

  const drawn = renderSeating(doc, indexDocument(doc), solution, { chair: 'Fixture Table' });
  check('a layout draws into the plan', drawn.ok, drawn.reason);
  check('one object per seat', drawn.chairs === solution.seats.length, `${drawn.chairs} vs ${solution.seats.length}`);

  const verdict = verifyWritable(doc);
  check('the seated plan verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'seated.rv4').document;
  const shapes = [...walk(reread)].filter((n) => n.cls === 'RVShape').length;
  check('every chair survives the round trip', shapes === 1 + solution.seats.length, `${shapes}`);

  // Regenerating replaces exactly what it drew.
  const tighter = solveSeating({ ...plan, maxSeats: 20 }, room);
  const redrawn = renderSeating(doc, indexDocument(doc), tighter, { chair: 'Fixture Table' }, drawn.created);
  // `placeGear` clones a whole subtree, so each chair is three objects and one
  // deletion takes all three. What matters is that none of them survive.
  const surviving = new Set([...walk(doc)].map((n) => n.id));
  check(
    'regenerating removes every object of the previous layout',
    !drawn.created.some((id) => surviving.has(id)),
  );
  check('one deletion per placed chair', redrawn.removed === solution.seats.length, `${redrawn.removed} vs ${solution.seats.length}`);
  check('and draws the new one', redrawn.chairs === 20, `${redrawn.chairs}`);
  check('leaving the original shape alone', [...walk(doc)].filter((n) => n.cls === 'RVShape').length === 1 + 20);
  check('and it still verifies', verifyWritable(doc).ok);
}

// ---------------------------------------------------------------------------
console.log('\nthe controls the original app has\n');

{
  // Orientation: a room set facing the short wall seats differently from one
  // set facing the long wall, and the difference is the point of the control.
  const room = rectangularRoom(80 * F, 40 * F, 'Ballroom');
  const focus = { x: 40 * F, y: -6 * F };
  const base = createSeatingPlan('theatre', focus);

  const short = solveSeating({ ...base, orientation: 'short-wall' }, room);
  const long = solveSeating({ ...base, orientation: 'long-wall' }, room);
  check('facing the short wall lays out', short.seats.length > 0, `${short.seats.length}`);
  check('facing the long wall lays out', long.seats.length > 0, `${long.seats.length}`);
  check('and they are different arrangements', short.seats.length !== long.seats.length, `${short.seats.length} vs ${long.seats.length}`);
  check('both stay inside the room', [...short.seats, ...long.seats].every((s) => containsPoint(room, s)));
}

{
  const room = rectangularRoom(60 * F, 40 * F);
  const focus = { x: 30 * F, y: -6 * F };
  const base = createSeatingPlan('theatre', focus);

  const noSide = solveSeating({ ...base, clearances: { ...base.clearances, side: 0, rear: 0 } }, room);
  const withSide = solveSeating({ ...base, clearances: { ...base.clearances, side: 6 * F, rear: 0 } }, room);
  check('a side aisle costs seats', withSide.seats.length < noSide.seats.length, `${withSide.seats.length} vs ${noSide.seats.length}`);

  const withRear = solveSeating({ ...base, clearances: { ...base.clearances, side: 0, rear: 10 * F } }, room);
  check('a rear clearance costs seats', withRear.seats.length < noSide.seats.length, `${withRear.seats.length} vs ${noSide.seats.length}`);

  const withFrontWall = solveSeating({ ...base, clearances: { ...base.clearances, side: 0, rear: 0, frontWall: 10 * F } }, room);
  check('a front-wall gap pushes the rows back', withFrontWall.seats.length < noSide.seats.length);
}

{
  // Sections: a centre bank and two wings, sized in seats.
  const room = rectangularRoom(80 * F, 50 * F);
  const focus = { x: 40 * F, y: -6 * F };
  const base = createSeatingPlan('theatre', focus);

  const plain = solveSeating(base, room);
  const sectioned = solveSeating(
    { ...base, sectioning: { enabled: true, centre: 10, wing: 5 }, clearances: { ...base.clearances, wing: 4 * F } },
    room,
  );
  check('a sectioned layout produces three banks', new Set(sectioned.seats.map((s) => s.section)).size === 3);
  check('and seats fewer than an unbroken block', sectioned.seats.length < plain.seats.length, `${sectioned.seats.length} vs ${plain.seats.length}`);
  check('all still inside the room', sectioned.seats.every((s) => containsPoint(room, s)));
}

{
  // Optimum picks the best of the arrangements it is allowed to vary.
  const room = rectangularRoom(80 * F, 40 * F);
  const focus = { x: 40 * F, y: -6 * F };
  const base = createSeatingPlan('theatre', focus);

  const asked = solveSeating(base, room);
  const best = solveOptimum({ ...base, optimum: true }, room);
  check('optimum seats at least as many', best.seats.length >= asked.seats.length, `${best.seats.length} vs ${asked.seats.length}`);
  check('and says what it chose', best.notes.some((n) => n.includes('Best of')), best.notes.join(' | '));
  check('optimum off changes nothing', solveOptimum(base, room).seats.length === asked.seats.length);

  // It must not buy seats by narrowing an aisle the user asked for.
  const wide = { ...base, optimum: true, clearances: { ...base.clearances, side: 8 * F } };
  const widened = solveOptimum(wide, room);
  const rows = new Map<number, typeof widened.seats>();
  for (const seat of widened.seats) {
    const list = rows.get(seat.row);
    if (list) list.push(seat);
    else rows.set(seat.row, [seat]);
  }
  check('the side aisle it was given survives the search', widened.seats.length < solveOptimum({ ...base, optimum: true, clearances: { ...base.clearances, side: 0 } }, room).seats.length);
}

{
  // An obstacle reserves its own floor, so nobody is seated in a column.
  const room = rectangularRoom(60 * F, 40 * F);
  const focus = { x: 30 * F, y: -6 * F };
  const column = {
    name: 'Column',
    x: 30 * F,
    y: 20 * F,
    width: 2 * F,
    depth: 2 * F,
    spec: { obstacle: true, clearance: 3 * F },
  };

  const reserved = reservedFromObstacles([column]);
  check('an obstacle reserves floor', reserved.length === 1);
  check('including its clearance', reserved[0].width === 8 * F, `${reserved[0].width / F}`);

  const base = createSeatingPlan('theatre', focus);
  const around = solveSeating({ ...base, reserved }, room);
  check(
    'nobody is seated inside the column or its clearance',
    !around.seats.some(
      (s) => s.x > reserved[0].x && s.x < reserved[0].x + reserved[0].width && s.y > reserved[0].y && s.y < reserved[0].y + reserved[0].height,
    ),
  );
  check('and it costs seats', around.seats.length < solveSeating(base, room).seats.length);

  check('something not flagged reserves nothing', reservedFromObstacles([{ ...column, spec: {} }]).length === 0);
}

{
  // The regression: on a plan with nothing to clone, placeGear synthesizes the
  // first item, which the caller's index has never seen. Every later placement
  // then matched that shape by name, failed to find it in the stale index, and
  // gave up with "object is not part of the document" — so seating worked on an
  // existing plan and failed on a new one.
  const blank = createBlankPlan({ room: { width: 60 * F, depth: 40 * F } });
  const doc = loadBuffer(blank.file!, 'new.rv4').document;
  const room = deriveRoom(doc).room;

  const plan = createSeatingPlan('banquet', { x: 30 * F, y: -6 * F });
  plan.maxSeats = 40;
  const solution = solveSeating(plan, room);
  check('a brand-new plan solves a banquet', solution.tables.length > 1, `${solution.tables.length}`);

  const drawn = renderSeating(doc, indexDocument(doc), solution, { chair: 'Chair', table: 'Round 60"' });
  check('and seating draws onto it', drawn.ok, drawn.reason);
  check('every table placed', drawn.tables === solution.tables.length, `${drawn.tables} of ${solution.tables.length}`);
  check('every chair placed', drawn.chairs === solution.seats.length, `${drawn.chairs} of ${solution.seats.length}`);
  check('and the result verifies', verifyWritable(doc).ok);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
