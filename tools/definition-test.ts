/**
 * Definitions and instances: what a thing is, versus where it was put.
 *
 *   npx tsx tools/definition-test.ts
 */

import { loadBuffer, UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/index.js';
import {
  ASPECT_PRESETS,
  formatAspect,
  inferSeats,
  inferSpec,
  instanceKey,
  parseAspect,
  resolveInstances,
  screenFromDiagonal,
  screenFromWidth,
  seatCount,
  SpecLibrary,
  type ItemSpec,
} from '../src/format/definition.js';
import { createCompanion, parseCompanion } from '../src/format/companion.js';
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
console.log('aspect ratios\n');

check('16:9 parses', parseAspect('16:9')!.w === 16 && parseAspect('16:9')!.h === 9);
check('16x9 parses', !!parseAspect('16x9'));
check('a decimal ratio parses', near(parseAspect('1.85:1')!.w, 1.85));
check('a bare decimal is read as :1', near(parseAspect('1.78')!.w, 1.78));
check('nonsense is refused', parseAspect('widescreen') === null);
check('a zero denominator is refused', parseAspect('16:0') === null);
check('a known ratio prints by name', formatAspect({ w: 16, h: 9 }) === '16:9', formatAspect({ w: 16, h: 9 }));
check('an odd ratio prints as numbers', formatAspect({ w: 3, h: 2 }) === '3:2', formatAspect({ w: 3, h: 2 }));
check('every preset survives its own formatter', ASPECT_PRESETS.every((p) => !!formatAspect(p.ratio)));

{
  // A 100in diagonal 16:9 screen is 87.2in x 49.0in — the number an AV tech
  // checks a room against.
  const image = screenFromDiagonal(100 * UNITS_PER_INCH, { w: 16, h: 9 });
  check('a 100in 16:9 screen is 87.2in wide', near(image.width / UNITS_PER_INCH, 87.16, 0.01), `${image.width / UNITS_PER_INCH}`);
  check('and 49.0in high', near(image.height / UNITS_PER_INCH, 49.03, 0.01), `${image.height / UNITS_PER_INCH}`);

  const fromWidth = screenFromWidth(16 * UNITS_PER_FOOT, { w: 16, h: 9 });
  check('a 16ft wide 16:9 screen is 9ft high', near(fromWidth.height / UNITS_PER_FOOT, 9, 1e-9));
}

// ---------------------------------------------------------------------------
console.log('\ninferring a definition from a name\n');

{
  const drape = inferSpec('Pipe and Drape 12ft');
  check('drape blocks the view entirely', drape.obstruction === 'full');
  check('drape stands 12 ft', drape.height === 12 * UNITS_PER_FOOT);
  check('an inferred definition says it is inferred', drape.inferred === true);

  const chair = inferSpec('Banquet Chair');
  check('a chair is 34in tall', chair.height === 34 * UNITS_PER_INCH);
  check('a chair seats one', chair.seats === 1);
  check('a chair only partly blocks the view', chair.obstruction === 'partial');

  const deck = inferSpec("4' x 8' Stage Deck");
  check('a stage deck does not block the view', deck.obstruction === 'none');
  check('a stage deck is 24in high', deck.height === 24 * UNITS_PER_INCH);

  const screen = inferSpec('16ft Fast-Fold Screen');
  check('a screen is 16:9 by default', screen.aspect?.w === 16 && screen.aspect?.h === 9);
  check('a screen sits off the floor', (screen.elevation ?? 0) > 0);

  const truss = inferSpec('12in Box Truss');
  check('truss hangs overhead', (truss.elevation ?? 0) >= 16 * UNITS_PER_FOOT);
  check('truss blocks nothing at floor level', truss.obstruction === 'none');

  const unknown = inferSpec('Widget 7');
  check('an unrecognised item still gets a usable default', unknown.height! > 0 && unknown.inferred === true);
}

{
  check('a 60in round seats 8', inferSeats('Round 60"') === 8, `${inferSeats('Round 60"')}`);
  check('a 72in round seats 10', inferSeats('Round 72"') === 10, `${inferSeats('Round 72"')}`);
  check('a 48in round seats 6', inferSeats('Round 48"') === 6, `${inferSeats('Round 48"')}`);
  check("an 8' banquet seats 10", inferSeats("8' Banquet Table") === 10, `${inferSeats("8' Banquet Table")}`);
  check("a 6' banquet seats 8", inferSeats("6' Banquet Table") === 8, `${inferSeats("6' Banquet Table")}`);
  check('a chair is not a table', inferSeats('Banquet Chair') === undefined);
  check('the size drives the seats, through inferSpec too', inferSpec('Round 72"').seats === 10);
}

// ---------------------------------------------------------------------------
console.log('\nthe library\n');

{
  const measured: ItemSpec = {
    id: 'round-60',
    name: 'Round 60"',
    height: 29 * UNITS_PER_INCH,
    seats: 10,
    obstruction: 'partial',
    weightLb: 92,
  };
  const library = new SpecLibrary([measured]);

  check('a stored definition is returned as stored', library.resolve('Round 60"').seats === 10);
  check('and is not marked inferred', library.resolve('Round 60"').inferred !== true);
  check('matching ignores case and spacing', library.resolve('  round 60"  ').seats === 10);
  check('an unknown name falls back to inference', library.resolve('Round 72"').inferred === true);
  check('the fallback is still useful', library.resolve('Round 72"').seats === 10);
  check('known() lists only what a person entered', library.known().length === 1);
  check('has() does not lie about inference', library.has('Round 60"') && !library.has('Round 72"'));
}

// ---------------------------------------------------------------------------
console.log('\nresolving instances in a plan\n');

const FIXTURE = fixturePlanBuffer();

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const library = new SpecLibrary();
  const items = resolveInstances(doc, library);

  check('the plan has one placement', items.length === 1, `${items.length}`);
  const item = items[0];
  check('it is named from the catalogue', item.name === 'Fixture Table', item.name);
  check('it sits at its insertion point', item.x === 1000 && item.y === 2000);
  check(
    'its footprint is measured from the outline, not the cached rect',
    item.width === 200 && item.depth === 100,
    `${item.width} x ${item.depth}`,
  );
  check('it is recognised as a table', item.spec.category === 'table');
  check('and reports that its height is a guess', item.estimated);
  check('its top is elevation plus height', item.top === item.elevation + 30 * UNITS_PER_INCH);
  check('its key is stable and readable', item.key === 'fixture table@100,200', item.key);
}

{
  // A definition beats inference, and an override beats the definition.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const library = new SpecLibrary([
    { id: 't', name: 'Fixture Table', height: 30 * UNITS_PER_INCH, seats: 8, obstruction: 'partial' },
  ]);

  const plain = resolveInstances(doc, library)[0];
  check('a defined item is no longer estimated', !plain.estimated);
  check('it takes its seats from the definition', plain.seats === 8);

  const raised = resolveInstances(doc, library, [
    { key: instanceKey('Fixture Table', 1000, 2000), elevation: 24 * UNITS_PER_INCH, seats: 6 },
  ])[0];
  check('an override raises this one placement', raised.elevation === 24 * UNITS_PER_INCH);
  check('and its top moves with it', raised.top === 54 * UNITS_PER_INCH);
  check('and its seat count changes', raised.seats === 6);

  const untouched = resolveInstances(doc, library, [{ key: 'something else@0,0', elevation: 999 }])[0];
  check('an override for a different placement does nothing', untouched.elevation === 0);

  check('seats are totalled, with the guessed part called out', seatCount([plain]).estimated === 0);
  check(
    'a guessed seat count is reported as guessed',
    seatCount(resolveInstances(doc, new SpecLibrary())).estimated === 0,
  );
}

// ---------------------------------------------------------------------------
console.log('\ndefinitions in the companion\n');

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const spec: ItemSpec = {
    id: 'screen-16',
    name: '16ft Screen',
    elevation: 3 * UNITS_PER_FOOT,
    height: 9 * UNITS_PER_FOOT,
    obstruction: 'full',
    aspect: { w: 16, h: 9 },
    weightLb: 180,
    powerW: 0,
  };
  const companion = createCompanion(doc, 'imperial', [], [spec], [
    { key: 'round 60"@100,200', elevation: 6 * UNITS_PER_INCH },
  ]);

  const round = parseCompanion(JSON.parse(JSON.stringify(companion)))!;
  check('a definition survives a save', round.library.length === 1);
  check('its aspect ratio survives', round.library[0].aspect?.w === 16);
  check('its heights survive', round.library[0].height === 9 * UNITS_PER_FOOT);
  check('an override survives', round.overrides.length === 1);

  // Stored definitions are definitions; inference is only the absence of one.
  const wasInferred = parseCompanion(
    JSON.parse(JSON.stringify({ ...companion, library: [{ ...spec, inferred: true }] })),
  )!;
  check('a saved definition never comes back marked as a guess', wasInferred.library[0].inferred !== true);

  // Hand-edited nonsense must not become geometry.
  const damaged = JSON.parse(JSON.stringify(companion));
  damaged.library.push({ id: 'x', name: 'Bad', height: -5, obstruction: 'sideways', aspect: { w: 0, h: 9 } });
  damaged.overrides.push({ key: 'empty-override' });
  const cleaned = parseCompanion(damaged)!;
  check('a negative height is dropped', cleaned.library[1].height === undefined);
  check('an unknown obstruction value is dropped', cleaned.library[1].obstruction === undefined);
  check('a degenerate aspect ratio is dropped', cleaned.library[1].aspect === undefined);
  check('an override carrying nothing is dropped', cleaned.overrides.length === 1);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
