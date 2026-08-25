/**
 * The stage builder and the AV checks.
 *
 *   npx tsx tools/stage-av-test.ts
 */

import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import {
  DECK_SIZES,
  deckOutlines,
  multiLevelStage,
  simpleStage,
  solveStage,
  stageBuildList,
  stageFootprint,
  stageReservedAreas,
  stageWarnings,
  stairSteps,
  type StageBuild,
} from '../src/format/stage.js';
import {
  checkSightlines,
  imageHeight,
  imageTop,
  pairScreen,
  projectionCone,
  recommendImageWidth,
  summariseSightlines,
  throwPositions,
  type Projector,
  type Screen,
} from '../src/format/av.js';
import { createSeatingPlan, solveSeating } from '../src/format/seating-plan.js';
import { rectangularRoom, roomArea } from '../src/format/room.js';
import { toSquareFeet } from '../src/format/units.js';
import type { PlacedItem } from '../src/format/definition.js';

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

const near = (a: number, b: number, t = 1e-6) => Math.abs(a - b) <= t;
const F = UNITS_PER_FOOT;
const IN = UNITS_PER_INCH;

// ---------------------------------------------------------------------------
console.log('stage decks\n');

{
  // 24 x 16 tiles exactly in 4x8 decks: three rows of three.
  const stage = simpleStage(0, 0, 24 * F, 16 * F, 24 * IN);
  const solved = solveStage(stage);
  check('a 24 x 16 stage tiles exactly', solved.notes.length === 0, solved.notes.join(' '));
  check('into twelve 4x8 decks', solved.decks.length === 12, `${solved.decks.length}`);
  check('all the same size', solved.decks.every((d) => d.size === "4' x 8'"));
  check(
    'covering the whole stage',
    near(toSquareFeet(solved.area), 24 * 16, 1e-6),
    `${toSquareFeet(solved.area)}`,
  );
  check('with no deck outside the footprint', solved.decks.every((d) => d.x >= 0 && d.y >= 0 && d.x + d.width <= 24 * F + 1e-6 && d.y + d.depth <= 16 * F + 1e-6));
  check('and none overlapping', (() => {
    for (let i = 0; i < solved.decks.length; i++) {
      for (let j = i + 1; j < solved.decks.length; j++) {
        const a = solved.decks[i];
        const b = solved.decks[j];
        const overlap = a.x < b.x + b.width - 1e-6 && b.x < a.x + a.width - 1e-6 && a.y < b.y + b.depth - 1e-6 && b.y < a.y + a.depth - 1e-6;
        if (overlap) return false;
      }
    }
    return true;
  })());
}

{
  // 23 ft does not tile: 8 + 8 + 6 gets to 22 and no stock deck fills the last
  // foot. (22 itself tiles exactly, which is the point of stocking a 4x6.)
  const stage = simpleStage(0, 0, 23 * F, 16 * F, 24 * IN);
  const solved = solveStage(stage);
  check('an awkward width is reported', solved.notes.length > 0, solved.notes.join(' '));
  check('in feet a person can act on', solved.notes[0].includes('ft'), solved.notes[0]);
  check('and the decks it can place are still placed', solved.decks.length > 0);
  check('using smaller stock to get closer', new Set(solved.decks.map((d) => d.size)).size > 1, [...new Set(solved.decks.map((d) => d.size))].join(', '));
}

{
  const stage = simpleStage(0, 0, 24 * F, 16 * F, 24 * IN);
  const solved = solveStage(stage);
  const list = stageBuildList(stage, solved);

  const decks = list.find((l) => l.item.startsWith('Deck'))!;
  check('the build list counts decks', decks.quantity === 12, `${decks.quantity}`);
  const legs = list.find((l) => l.item.startsWith('Legs'))!;
  check('and legs, four per deck', legs.quantity === 48, `${legs.quantity}`);
  check('at the right height', legs.item.includes('24in'), legs.item);
  const skirt = list.find((l) => l.item.startsWith('Skirt'))!;
  check('and skirt by the linear foot', skirt.quantity === 2 * (24 + 16), `${skirt.quantity}`);
  check('and the stair unit', list.some((l) => l.item.startsWith('Stair unit')));

  const odd = simpleStage(0, 0, 24 * F, 16 * F, 22 * IN);
  const oddList = stageBuildList(odd, solveStage(odd));
  const oddLegs = oddList.find((l) => l.item.startsWith('Legs'))!;
  check('a non-stock leg height is flagged', !!oddLegs.detail, oddLegs.detail);
}

{
  check('a 24in stage needs three 8in steps', stairSteps(24 * IN, 8 * IN).count === 3);
  check('with the rise coming out exact', near(stairSteps(24 * IN, 8 * IN).actualRise, 8 * IN));
  check('an odd height splits evenly', near(stairSteps(30 * IN, 8 * IN).actualRise * stairSteps(30 * IN, 8 * IN).count, 30 * IN, 1e-9));
  check('a floor-level stage needs no steps', stairSteps(0, 8 * IN).count === 0);
}

{
  const high: StageBuild = { ...simpleStage(0, 0, 24 * F, 16 * F, 48 * IN), stairs: [] };
  const warnings = stageWarnings(high);
  check('a high stage with no stairs is flagged', warnings.some((w) => w.includes('no stairs')), warnings.join(' | '));
  check('and so is the guardrail threshold', warnings.some((w) => w.includes('guardrail')), warnings.join(' | '));

  const steep = simpleStage(0, 0, 24 * F, 16 * F, 36 * IN);
  steep.stairs[0].riserHeight = 12 * IN;
  steep.stairs[0].handrail = false;
  const steepWarnings = stageWarnings(steep);
  check('steep stairs are flagged', steepWarnings.some((w) => w.includes('steep')), steepWarnings.join(' | '));
  check('a missing handrail is flagged', steepWarnings.some((w) => w.includes('handrail')), steepWarnings.join(' | '));

  const fine = simpleStage(0, 0, 24 * F, 16 * F, 24 * IN);
  check('a sensible stage warns about nothing', stageWarnings(fine).length === 0, stageWarnings(fine).join(' | '));
}

{
  const stage = simpleStage(10 * F, 2 * F, 24 * F, 16 * F, 24 * IN);
  const footprint = stageFootprint(stage)!;
  check('a stage has a footprint', near(toSquareFeet(roomArea(footprint)), 24 * 16, 1e-6));

  const reserved = stageReservedAreas(stage);
  check('the stage reserves its own floor', reserved.some((r) => r.width === 24 * F && r.height === 16 * F));
  check('and the stairs reserve a landing', reserved.length > 1, `${reserved.length}`);
  check('the landing is in front of the stage', reserved[1].y >= 2 * F + 16 * F - 1e-6);

  check('every deck can be drawn', deckOutlines(solveStage(stage)).every((o) => o.length === 5));
  check('deck sizes are stocked longest first', DECK_SIZES[0].width >= DECK_SIZES[1].width);
}

{
  // The stage and the seating agree: reserved floor takes seats out.
  const room = rectangularRoom(60 * F, 40 * F, 'Ballroom');
  const stage = simpleStage(18 * F, 0, 24 * F, 16 * F, 24 * IN);
  const plan = createSeatingPlan('theatre', { x: 30 * F, y: 8 * F });
  const open = solveSeating(plan, room);
  const withStage = solveSeating({ ...plan, reserved: stageReservedAreas(stage) }, room);
  check('putting a stage in costs seats', withStage.seats.length < open.seats.length, `${withStage.seats.length} vs ${open.seats.length}`);
  check(
    'and no seat is on the stage',
    !withStage.seats.some((s) => s.x > 18 * F && s.x < 42 * F && s.y > 0 && s.y < 16 * F),
  );
}

// ---------------------------------------------------------------------------
console.log('\nscreens and projectors\n');

const screen: Screen = {
  id: 's1',
  x: 30 * F,
  y: 4 * F,
  facing: Math.PI / 2, // image faces down the room, +y
  imageWidth: 16 * F,
  aspect: { w: 16, h: 9 },
  bottomHeight: 4 * F,
};

{
  check('a 16 ft 16:9 image is 9 ft high', near(imageHeight(screen) / F, 9, 1e-9));
  check('and its top is 13 ft up', near(imageTop(screen) / F, 13, 1e-9));
}

{
  // A 1.8:1 lens needs 28.8 ft for a 16 ft image.
  const projector: Projector = { id: 'p1', x: 30 * F, y: 4 * F + 28.8 * F, throwMin: 1.8, throwMax: 2.4, height: 3 * F };
  const paired = pairScreen(screen, projector);
  check('a correctly placed projector pairs cleanly', paired.ok, paired.problems.join(' | '));
  check('at the throw ratio the lens starts at', near(paired.throwRatio, 1.8, 1e-9), `${paired.throwRatio}`);
  check('and the working range is reported in real distance', near(paired.workingRange.min / F, 28.8, 1e-9));

  const tooClose: Projector = { ...projector, y: 4 * F + 20 * F };
  const near1 = pairScreen(screen, tooClose);
  check('a projector inside its lens range is caught', !near1.ok);
  check('and told how far back it needs to be', near1.problems[0].includes('28.8 ft'), near1.problems[0]);

  const tooFar: Projector = { ...projector, y: 4 * F + 60 * F };
  const far = pairScreen(screen, tooFar);
  check('a projector beyond its lens range is caught', !far.ok && far.problems[0].includes('Too far'), far.problems.join(' | '));

  const offAxis: Projector = { ...projector, x: 30 * F + 25 * F };
  check('an off-axis projector is caught', pairScreen(screen, offAxis).problems.some((p) => p.includes('off the screen centreline')));

  const dim: Projector = { ...projector, lumens: 3000 };
  check('a dim projector is caught', pairScreen(screen, dim).problems.some((p) => p.includes('dim')));
  const bright: Projector = { ...projector, lumens: 20000 };
  check('a bright one is not', pairScreen(screen, bright).ok);
}

{
  const range = throwPositions(screen, 1.8, 2.4);
  check('the near position is one throw-min away', near(Math.hypot(range.near.x - screen.x, range.near.y - screen.y) / F, 28.8, 1e-9));
  check('and the far one is throw-max', near(Math.hypot(range.far.x - screen.x, range.far.y - screen.y) / F, 38.4, 1e-9));

  const cone = projectionCone(screen, { id: 'p', x: 30 * F, y: 34 * F, throwMin: 1.8, throwMax: 2.4, height: 3 * F });
  check('the cone is a closed triangle', cone.length === 4 && cone[0].x === cone[3].x);
  check('spanning the image width at the screen', near(Math.hypot(cone[1].x - cone[2].x, cone[1].y - cone[2].y) / F, 16, 1e-9));
}

// ---------------------------------------------------------------------------
console.log('\nsightlines\n');

{
  const room = rectangularRoom(60 * F, 100 * F, 'Long hall');
  const plan = createSeatingPlan('theatre', { x: 30 * F, y: 0 });
  const solution = solveSeating(plan, room);

  const views = checkSightlines(solution.seats, screen);
  const summary = summariseSightlines(views);
  check('every seat is graded', summary.total === solution.seats.length);
  check('some seats are clear', summary.clear > 0, JSON.stringify(summary));
  check('a long room puts seats beyond six image heights', summary.tooFar > 0, JSON.stringify(summary));
  check('and the summary says so in words', summary.notes.some((n) => n.includes('six image heights')), summary.notes.join(' | '));

  const backRow = views.reduce((worst, v) => (v.imageHeights > worst.imageHeights ? v : worst));
  check('the furthest seat is the worst', backRow.verdict !== 'clear');

  // A bigger image fixes it.
  const wanted = recommendImageWidth(solution.seats, screen);
  check('a suitable image width is recommended', wanted > screen.imageWidth, `${wanted / F} ft`);
  const fixed = summariseSightlines(checkSightlines(solution.seats, { ...screen, imageWidth: wanted }));
  check('and using it clears the distance problem', fixed.tooFar === 0, JSON.stringify(fixed));
}

{
  // A drape line across the room blocks the seats behind it.
  const room = rectangularRoom(60 * F, 60 * F, 'Hall');
  const plan = createSeatingPlan('theatre', { x: 30 * F, y: 0 });
  const solution = solveSeating(plan, room);

  const drape: PlacedItem = {
    nodeId: 1,
    key: 'drape@0,0',
    name: 'Pipe and Drape',
    x: 30 * F,
    y: 30 * F,
    rotation: 0,
    width: 40 * F,
    depth: 1 * F,
    spec: { id: 'd', name: 'Pipe and Drape', obstruction: 'full', height: 12 * F },
    elevation: 0,
    top: 12 * F,
    obstruction: 'full',
    seats: 0,
    estimated: false,
  };

  const clear = summariseSightlines(checkSightlines(solution.seats, screen));
  const blocked = summariseSightlines(checkSightlines(solution.seats, screen, [drape]));
  check('a drape blocks seats behind it', blocked.blocked > 0, JSON.stringify(blocked));
  check('and none were blocked without it', clear.blocked === 0);
  check('the report names what is in the way', blocked.notes.some((n) => n.includes('Pipe and Drape')), blocked.notes.join(' | '));

  // A dance floor blocks nothing.
  const floor: PlacedItem = { ...drape, name: 'Dance Floor', obstruction: 'none', top: 1 * F };
  check('something you can see over blocks nobody', summariseSightlines(checkSightlines(solution.seats, screen, [floor])).blocked === 0);

  // A table is not tall enough to block a seated eye line to a raised screen.
  const table: PlacedItem = { ...drape, name: 'Round 60', obstruction: 'partial', top: 30 * 10, width: 5 * F, depth: 5 * F };
  check('a table does not block a raised screen', summariseSightlines(checkSightlines(solution.seats, screen, [table])).blocked === 0);
}

{
  const seats = [{ x: 30 * F, y: 8 * F, rotation: 0, row: 0, seat: 0, section: 0 }];
  const views = checkSightlines(seats, screen);
  check('a seat right under the screen is too close', views[0].verdict === 'too-close', views[0].verdict);

  // Close enough to pass the distance test, but 62 degrees round the side.
  const sideSeat = [{ x: 60 * F, y: 20 * F, rotation: 0, row: 0, seat: 0, section: 0 }];
  check('a seat far off to the side is off-axis', checkSightlines(sideSeat, screen)[0].verdict === 'off-axis', checkSightlines(sideSeat, screen)[0].verdict);

  check('an empty house summarises without complaint', summariseSightlines([]).total === 0);
  check('a good house says so', summariseSightlines(checkSightlines([{ x: 30 * F, y: 40 * F, rotation: 0, row: 0, seat: 0, section: 0 }], screen)).notes[0].includes('clear'));
}


// ── Stage builds beyond two tiers ───────────────────────────────────────────
console.log('\nstages with more than two levels, ramps and rails\n');
{
  const FT = 120;
  const IN = 10;

  // A keynote set: downstage thrust, main deck, upstage band riser.
  const build = multiLevelStage(0, 0, 40 * FT, [
    { depth: 8 * FT, height: 16 * IN, label: 'Thrust' },
    { depth: 24 * FT, height: 32 * IN, label: 'Main deck' },
    { depth: 8 * FT, height: 48 * IN, label: 'Band riser' },
  ], { stairEdges: ['left', 'right'], rampEdges: ['front'], railEdges: ['back'] });

  check('three levels build', build.levels.length === 3, `${build.levels.length}`);
  check(
    'levels stack front to back without overlapping',
    build.levels[1]!.y === build.levels[0]!.y + build.levels[0]!.depth &&
      build.levels[2]!.y === build.levels[1]!.y + build.levels[1]!.depth,
  );
  check(
    'access attaches to the tallest level, not the first',
    build.stairs.every((s) => s.level === 2) && build.ramps.every((r) => r.level === 2),
    JSON.stringify({ stairs: build.stairs.map((s) => s.level), ramps: build.ramps.map((r) => r.level) }),
  );

  const solution = solveStage(build);
  check('every level tiles into decks', solution.decks.length > 0, `${solution.decks.length} decks`);
  check(
    'decks carry the height of the level they belong to',
    new Set(solution.decks.map((d) => d.height)).size === 3,
    [...new Set(solution.decks.map((d) => d.height / IN))].join(', '),
  );

  const list = stageBuildList(build, solution);
  const ramp = list.find((l) => l.item.startsWith('Ramp '));
  check('the ramp is on the build list', !!ramp, list.map((l) => l.item).join(' | '));
  // 48in of rise at 1:12 is 48ft of ramp — the number that decides whether it fits.
  check('and is priced by its run, not its rise', /48\.0ft run/.test(ramp?.detail ?? ''), ramp?.detail);
  check('the guardrail is on the build list', list.some((l) => l.item.startsWith('Guardrail')));
  check('skirting is still on the build list', list.some((l) => l.item.startsWith('Skirt')));

  const warned = stageWarnings(build);
  check(
    'a 48ft ramp run is flagged as needing to fit',
    warned.some((w) => /runs 48ft/.test(w)),
    warned.join(' | '),
  );

  // A ramp steeper than 1:12 is not an accessible ramp, whatever it is called.
  const steep = multiLevelStage(0, 0, 20 * FT, [{ depth: 12 * FT, height: 24 * IN }], {
    rampEdges: ['front'],
  });
  steep.ramps[0]!.slope = 8;
  check(
    'a 1:8 ramp is called out against the 1:12 limit',
    stageWarnings(steep).some((w) => /1:8/.test(w) && /1:12/.test(w)),
    stageWarnings(steep).join(' | '),
  );
}

console.log('\nforcing a stock deck size\n');
{
  const FT = 120;

  const free = solveStage(multiLevelStage(0, 0, 24 * FT, [{ depth: 16 * FT, height: 240 }]));
  const forced = solveStage(
    multiLevelStage(0, 0, 24 * FT, [{ depth: 16 * FT, height: 240 }], { preferredDeck: "4' x 4'" }),
  );

  check(
    'a forced size is the only size used',
    new Set(forced.decks.map((d) => d.size)).size === 1 && forced.decks[0]!.size === "4' x 4'",
    [...new Set(forced.decks.map((d) => d.size))].join(', '),
  );
  check(
    'and it takes more of them than letting the tiler choose',
    forced.decks.length > free.decks.length,
    `${forced.decks.length} forced vs ${free.decks.length} free`,
  );
  check(
    'an unknown deck label is reported rather than failing the build',
    solveStage(
      multiLevelStage(0, 0, 24 * FT, [{ depth: 16 * FT, height: 240 }], { preferredDeck: '9 x 9' }),
    ).notes.some((n) => /not a stock deck size/.test(n)),
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
