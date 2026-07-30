/**
 * Allocation, layers, and the report that assembles the whole plan.
 *
 *   npx tsx tools/report-test.ts
 */

import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import {
  allocate,
  allocationCsv,
  shortages,
  summariseAllocation,
  untracked,
} from '../src/format/allocation.js';
import {
  buildLegend,
  defaultLayers,
  groupByLayer,
  itemEditable,
  layerOf,
  printedLayers,
  reorderLayer,
  suggestLayer,
  titleBlockFor,
} from '../src/format/layers.js';
import { buildPullSheet, buildReport } from '../src/format/report.js';
import { checkSightlines, summariseSightlines, type Screen } from '../src/format/av.js';
import { createSeatingPlan, solveSeating } from '../src/format/seating-plan.js';
import { simpleStage, solveStage, stageReservedAreas } from '../src/format/stage.js';
import { rectangularRoom } from '../src/format/room.js';
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

const F = UNITS_PER_FOOT;

/** A placement, with only the fields these modules read. */
function placed(name: string, n: number, estimated = false): PlacedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: i,
    key: `${name.toLowerCase()}@${i},0`,
    name,
    x: i * 100,
    y: 0,
    rotation: 0,
    width: 5 * F,
    depth: 5 * F,
    spec: { id: name, name },
    elevation: 0,
    top: 30 * UNITS_PER_INCH,
    obstruction: 'partial' as const,
    seats: 0,
    estimated,
  }));
}

// ---------------------------------------------------------------------------
console.log('allocation\n');

{
  const items = [
    ...placed('Round 60"', 20),
    ...placed('Banquet Chair', 160),
    ...placed('Pipe and Drape', 12),
    ...placed('Dance Floor', 1),
    ...placed('Mystery Widget', 3),
  ];
  const owned = new Map([
    ['Round 60"', 24],
    ['banquet chair', 120],
    ['Pipe and Drape', 40],
  ]);

  const result = allocate(items, owned);

  const rounds = result.find((a) => a.name === 'Round 60"')!;
  check('an item in stock is fine', rounds.state === 'ok');
  check('with the remainder counted', rounds.remaining === 4, `${rounds.remaining}`);

  const chairs = result.find((a) => a.name === 'Banquet Chair')!;
  check('a shortfall is caught', chairs.state === 'short');
  check('matched case-insensitively against the inventory', chairs.owned === 120);
  check('with the number to sub-hire', chairs.shortfall === 40, `${chairs.shortfall}`);

  const widget = result.find((a) => a.name === 'Mystery Widget')!;
  check('an item not in the inventory is untracked, not short', widget.state === 'untracked');
  check('and its shortfall is not invented', widget.shortfall === 0 && widget.remaining === null);

  const floor = result.find((a) => a.name === 'Dance Floor')!;
  check('a drawn area is conceptual', floor.state === 'conceptual');
  check('and is not counted as short', floor.shortfall === 0);

  check('shortages come first', result[0].state === 'short');
  check('and conceptual lines last', result[result.length - 1].state === 'conceptual');

  check('shortages() lists only shortages', shortages(result).length === 1);
  check('untracked() lists only unknowns', untracked(result).length === 1);
}

{
  const items = [...placed('Round 60"', 5, true)];
  const result = allocate(items, new Map([['Round 60"', 10]]));
  check('an estimated size is carried through', result[0].estimated);

  const summary = summariseAllocation(result);
  check('the summary counts estimated lines', summary.estimatedLines === 1);
  check('and says nothing is short', summary.shortLines === 0);

  const clean = summariseAllocation(allocate(placed('Round 60"', 2), new Map([['Round 60"', 10]])));
  check('an all-in-stock plan says so plainly', clean.notes[0].includes('in stock'), clean.notes.join(' | '));
}

{
  // A name that would be caught by the conceptual rule but is a real item.
  const items = placed('Bar Stool', 8);
  const literal = allocate(items, new Map([['Bar Stool', 4]]), { literal: ['Bar Stool'] });
  check('an item can be forced to count as real', literal[0].state === 'short', literal[0].state);

  const custom = allocate(placed('Client Table', 2), new Map());
  check('a client placeholder is conceptual by name', custom[0].state === 'conceptual');
}

{
  const result = allocate([...placed('Round 60"', 20), ...placed('Dance Floor', 1)], new Map([['Round 60"', 10]]));
  const csv = allocationCsv(result);
  check('the pull sheet has a header row', csv.split('\n')[0].startsWith('Item,Placed,Owned'));
  check('and a row per line', csv.trim().split('\n').length === 3, `${csv.trim().split('\n').length}`);
  check('quoting names that need it', allocationCsv(allocate(placed('Table, Round', 1), new Map())).includes('"Table, Round"'));

  const sheet = buildPullSheet(result);
  check('the warehouse sheet leaves out drawn areas', !sheet.includes('Dance Floor'), sheet);
}

// ---------------------------------------------------------------------------
console.log('\nlayers\n');

{
  const layers = defaultLayers();
  check('there is a layer per technical system', layers.length === 9, `${layers.length}`);
  check('architecture is locked by default', layers.find((l) => l.id === 'architecture')!.locked);

  check('a screen goes on video', suggestLayer('16ft Fast-Fold Screen') === 'video');
  check('a leko goes on lighting', suggestLayer('Leko Light') === 'lighting');
  check('a deck goes on staging', suggestLayer("4' x 8' Stage Deck") === 'staging');
  check('drape goes on drape', suggestLayer('Pipe and Drape') === 'drape');
  check('a chair goes on seating', suggestLayer('Banquet Chair') === 'seating');
  check('a speaker goes on audio', suggestLayer('Line Array Speaker') === 'audio');
  check('something unrecognised still lands somewhere', !!suggestLayer('Widget 7'));

  const items = [...placed('Banquet Chair', 4), ...placed('Leko Light', 2)];
  const assignment = { [items[0].key]: 'lighting' };
  check('an explicit assignment beats the guess', layerOf(items[0], assignment) === 'lighting');
  check('and the rest still follow the guess', layerOf(items[1], assignment) === 'seating');

  const groups = groupByLayer(items, layers, assignment);
  check('placements group by layer', groups.length === 2, `${groups.length}`);
  check('in draw order', groups[0].layer.order <= groups[1].layer.order);

  check('a locked layer blocks editing', !itemEditable(items[1], [...layers.map((l) => (l.id === 'seating' ? { ...l, locked: true } : l))], {}));
  check('an unlocked one allows it', itemEditable(items[1], layers, {}));
}

{
  const layers = defaultLayers();
  const moved = reorderLayer(layers, 'video', -1);
  const before = layers.sort((a, b) => a.order - b.order).map((l) => l.id);
  const after = moved.sort((a, b) => a.order - b.order).map((l) => l.id);
  check('a layer moves up the order', after.indexOf('video') === before.indexOf('video') - 1, after.join(','));
  check('the orders stay tidy', moved.every((l, i) => l.order === i * 10));
  check('moving the first layer up does nothing', reorderLayer(layers, 'architecture', -1) === layers);
  check('an unknown layer is ignored', reorderLayer(layers, 'nope', 1) === layers);

  const hidden = layers.map((l) => (l.id === 'lighting' ? { ...l, printed: false } : l));
  check('an unprinted layer is left off the sheet', !printedLayers(hidden).some((l) => l.id === 'lighting'));
}

{
  const items = [...placed('Banquet Chair', 12), ...placed('Round 60"', 2), ...placed('Leko Light', 3)];
  const legend = buildLegend(items, defaultLayers(), {});
  check('the legend is built from the drawing', legend.length === 3, `${legend.length}`);
  check('with counts', legend.find((e) => e.name === 'Banquet Chair')!.count === 12);
  check('grouped by layer', new Set(legend.map((e) => e.layer)).size === 2, [...new Set(legend.map((e) => e.layer))].join(','));
  check('most numerous first within a layer', legend[0].count >= legend[1].count);
}

// ---------------------------------------------------------------------------
console.log('\nthe report\n');

{
  const room = rectangularRoom(60 * F, 40 * F, 'Grand Ballroom');
  const stage = simpleStage(18 * F, 0, 24 * F, 16 * F, 24 * UNITS_PER_INCH);
  const plan = createSeatingPlan('theatre', { x: 30 * F, y: 8 * F });
  const seating = solveSeating({ ...plan, reserved: stageReservedAreas(stage) }, room);

  const screen: Screen = {
    id: 's',
    x: 30 * F,
    y: 4 * F,
    facing: Math.PI / 2,
    imageWidth: 16 * F,
    aspect: { w: 16, h: 9 },
    bottomHeight: 4 * F,
  };
  const sightlines = summariseSightlines(checkSightlines(seating.seats, screen));

  const items = [...placed('Banquet Chair', 300), ...placed('Pipe and Drape', 20)];
  const allocation = allocate(items, new Map([['Banquet Chair', 250]]));

  const report = buildReport({
    title: titleBlockFor('Grand Ballroom — Awards Dinner', '1/8" = 1\'', {
      venue: 'Riverside Convention Centre',
      client: 'Acme Corp',
      date: '2026-09-14',
      drawnBy: 'P. Thompson',
      revision: 'C',
    }),
    units: 'imperial',
    room,
    items,
    seating,
    stage: { build: stage, solution: solveStage(stage) },
    allocation,
    sightlines,
    legend: buildLegend(items, defaultLayers(), {}),
    warnings: ['Air wall position not confirmed with the venue.'],
  });

  check('the report has a title', report.startsWith('# Grand Ballroom'));
  check('and the title block facts', report.includes('Riverside Convention Centre') && report.includes('Acme Corp'));
  check('warnings come first', report.indexOf('Check before issuing') < report.indexOf('## Room'));
  check('the room section reports real area', report.includes('2,400 sq ft'), report.slice(0, 900));
  check('capacity is offered by layout', report.includes('Capacity by layout') && report.includes('theatre'));
  check('and is labelled as an estimate, not occupancy', report.includes('occupancy'));
  check('the seating count is reported', report.includes('## Seating'));
  check('the stage build list is there', report.includes("Deck 4' x 8'"));
  check('with legs counted', report.includes('Legs 24in'));
  check('sightlines are reported', report.includes('## Sightlines'));
  check('the shortage is called out in bold', report.includes('**50**'), report.slice(report.indexOf('## Equipment')));
  check('and named in the summary', report.includes('Banquet Chair (50)'));
  check('the legend lists what is on the sheet', report.includes('## Legend'));
  check('the report ends with a single newline', report.endsWith('\n') && !report.endsWith('\n\n'));
  check('and has no triple blank lines', !report.includes('\n\n\n'));
}

{
  // A bare plan: sections with nothing to say are left out entirely.
  const report = buildReport({
    title: titleBlockFor('Untitled', '1:100'),
    units: 'metric',
    room: rectangularRoom(10 * F, 10 * F),
  });
  check('an empty plan still produces a report', report.includes('# Untitled'));
  check('with no stage section', !report.includes('Deck'));
  check('no equipment section', !report.includes('## Equipment'));
  check('no sightlines section', !report.includes('## Sightlines'));
  check('and metric units', report.includes('m²'), report);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
