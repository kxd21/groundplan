/**
 * Cable runs: what is in them, how they draw, and what to order.
 *
 *   npx tsx tools/cable-test.ts
 *
 * A run used to be a named polyline. The drawing could say a run existed and
 * could not say whether it was fibre or a soca — which are different rental
 * lines, different floor loads, and different answers to "can this be taped
 * down next to that".
 */

import {
  CABLE_KINDS,
  cableSchedule,
  cableSpec,
  classifyCable,
  STOCK_LENGTHS,
  toStockLength,
  type CableRun,
} from '../src/format/cable.js';
import { resolveStyle } from '../src/format/style.js';
import type { ScenePrimitive } from '../src/format/scene.js';

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

const FT = 120;

console.log('\na run is classified by what it is called');
{
  const cases: Array<[string, string]> = [
    ['FOH power feeder', 'power'],
    ['Soca to stage left', 'power'],
    ['Edison drop', 'power'],
    ['Audio snake FOH to stage', 'audio'],
    ['XLR run to podium', 'audio'],
    ['SDI to camera 2', 'video'],
    ['12G coax', 'video'],
    ['Cat6 to switch', 'network'],
    ['Dante network run', 'network'],
    ['Fiber to video world', 'fiber'],
    ['SMPTE fibre', 'fiber'],
    ['DMX to truss', 'dmx'],
    ['sACN control run', 'dmx'],
  ];
  for (const [name, want] of cases) {
    const got = classifyCable(name);
    check(`"${name}" → ${want}`, got === want, `got ${got}`);
  }
  check(
    'an unlabelled run is power, which is the common case and the visible one',
    classifyCable('Run 3') === 'power',
    classifyCable('Run 3'),
  );
}

console.log('\neach kind draws as its own line');
{
  const run = (owner: string): ScenePrimitive =>
    ({
      id: 1,
      nodeId: 1,
      selectId: 1,
      type: 'polyline',
      pts: [0, 0, 100, 0, 200, 0],
      color: 0,
      cls: 'RVSegmentPoly',
      layer: 'other',
      discipline: 'power',
      owner,
    }) as unknown as ScenePrimitive;

  const power = resolveStyle(run('FOH power feeder'));
  const fiber = resolveStyle(run('Fiber to video world'));
  const dmx = resolveStyle(run('DMX to truss'));

  check('a cable run is styled as a cable run', power.source === 'cable', power.source);
  check('power is solid', power.dash === undefined, JSON.stringify(power.dash));
  check('fibre is dashed', Array.isArray(fiber.dash), JSON.stringify(fiber.dash));
  check('dmx is dashed', Array.isArray(dmx.dash), JSON.stringify(dmx.dash));
  check(
    'and no two kinds look the same',
    new Set(
      CABLE_KINDS.map((k) => `${k.stroke}|${(k.dash ?? []).join(',')}|${k.strokePoints}`),
    ).size === CABLE_KINDS.length,
  );

  // A piece of equipment that merely has a cable-ish word in its name must not
  // be redrawn as a run.
  const closedDeck = {
    ...run('Cable Ramp'),
    pts: [0, 0, 100, 0, 100, 100, 0, 100, 0, 0],
  } as ScenePrimitive;
  check(
    'a closed outline is equipment, not a run',
    resolveStyle(closedDeck).source !== 'cable',
    resolveStyle(closedDeck).source,
  );
}

console.log('\nfootage is ordered in stock lengths, not drawn lengths');
{
  check('47ft of anything is a 50ft length', toStockLength(47) === 50, `${toStockLength(47)}`);
  check('exactly 50 stays 50', toStockLength(50) === 50, `${toStockLength(50)}`);
  check('51 goes to 100', toStockLength(51) === 100, `${toStockLength(51)}`);
  check(
    'past the longest stock it rounds up in 50s',
    toStockLength(340) === 350,
    `${toStockLength(340)}`,
  );
  check('every stock length maps to itself', STOCK_LENGTHS.every((l) => toStockLength(l) === l));
}

console.log('\nthe schedule totals by kind, and shows the slack');
{
  const runs: CableRun[] = [
    { name: 'FOH power feeder', kind: 'power', length: 120 * FT },
    { name: 'Stage left power', kind: 'power', length: 47 * FT },
    { name: 'SDI camera 1', kind: 'video', length: 90 * FT },
    { name: 'SDI camera 2', kind: 'video', length: 92 * FT },
    { name: 'Fiber to video world', kind: 'fiber', length: 210 * FT },
  ];
  const schedule = cableSchedule(runs);

  check('one line per kind, not per run', schedule.lines.length === 3, `${schedule.lines.length}`);
  check(
    'runs are counted',
    schedule.lines.find((l) => l.kind === 'power')?.runs === 2,
    JSON.stringify(schedule.lines.find((l) => l.kind === 'power')),
  );
  check(
    'drawn footage is the sum as drawn',
    Math.abs(schedule.totalFeet - (120 + 47 + 90 + 92 + 210)) < 1e-6,
    `${schedule.totalFeet}`,
  );
  // 120→150, 47→50, 90→100, 92→100, 210→250
  check(
    'order footage rounds each run to stock',
    schedule.totalOrderFeet === 150 + 50 + 100 + 100 + 250,
    `${schedule.totalOrderFeet}`,
  );
  check(
    'and the order total is never below the drawn total',
    schedule.totalOrderFeet >= schedule.totalFeet,
  );
  check(
    'kinds report in a fixed order so two plans compare line for line',
    schedule.lines.map((l) => l.kind).join(',') === 'power,video,fiber',
    schedule.lines.map((l) => l.kind).join(','),
  );
  check('an empty plan schedules nothing', cableSchedule([]).lines.length === 0);
}

console.log('\nevery kind has a spec');
{
  for (const kind of CABLE_KINDS) {
    check(
      `${kind.id} resolves and has a short label`,
      cableSpec(kind.id).id === kind.id && kind.shortLabel.length > 0,
    );
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
