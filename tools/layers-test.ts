/**
 * Production layers: what a placement files itself under, and what it costs.
 *
 *   npx tsx tools/layers-test.ts
 *
 * The layer taxonomy shipped in the format long before any user could reach it.
 * Now that the panel drives it, the classification rules are load-bearing: a
 * chain motor filed under Lighting means the rigger's sheet is wrong, and a
 * network switch filed under Seating means it is missing from the data run.
 */

import {
  DEFAULT_LAYERS,
  defaultLayers,
  disciplineFor,
  suggestLayer,
  summariseLoad,
} from '../src/format/layers.js';
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

console.log('\nevery layer is reachable and ordered');
{
  const ids = DEFAULT_LAYERS.map((l) => l.id);
  check('there are no duplicate layer ids', new Set(ids).size === ids.length, ids.join(', '));
  const orders = DEFAULT_LAYERS.map((l) => l.order);
  check(
    'draw order is strictly increasing',
    orders.every((o, i) => i === 0 || o > orders[i - 1]!),
    orders.join(', '),
  );
  check(
    'architecture is locked by default',
    DEFAULT_LAYERS.find((l) => l.id === 'architecture')?.locked === true,
  );
}

console.log('\nthe gear a live event actually carries files itself correctly');
{
  const expected: Array<[string, string]> = [
    // Video — the ones that used to fall through to seating.
    ['PTZ Camera', 'video'],
    ['Video Camera', 'video'],
    ['Confidence Monitor', 'video'],
    ['DSM', 'video'],
    ['Video Rack', 'video'],
    ['Video Switcher', 'video'],
    ['Fastfold Screen 10x17', 'video'],
    ['Barco LC Projector', 'video'],

    // Rigging — these used to land on Lighting, which hangs the fixture but
    // never signs off the point.
    ['Chain Motor', 'rigging'],
    ['Chain Hoist 1 Ton', 'rigging'],
    ['Rigging Point', 'rigging'],
    ['Box Truss', 'rigging'],
    ['Triangle Truss 10\'', 'rigging'],

    // Power and data.
    ['Distro', 'power'],
    ['Power Drop', 'power'],
    ['Network Switch', 'power'],
    ['Cable Ramp', 'power'],
    ['Cable Mat', 'power'],
    ['DMX Run', 'power'],

    // Audio.
    ['Audio Console', 'audio'],
    ['FOH Rack', 'audio'],
    ['Subwoofer', 'audio'],
    ['Speaker', 'audio'],

    // Lighting, still.
    ['Source 4 Par', 'lighting'],
    ['Leko Light', 'lighting'],
    ['Mac 600 Moving Light', 'lighting'],

    // The originals must not have regressed.
    ['Round 66"', 'seating'],
    ['Standard 18"x18"', 'seating'],
    ['Stage Deck 4x8', 'staging'],
    ['Riser 8\' x 42\'', 'staging'],
    ['Pipe and Drape', 'drape'],
    ['Buffet Table', 'catering'],
  ];

  for (const [name, want] of expected) {
    const got = suggestLayer(name);
    check(`${name} → ${want}`, got === want, `filed under ${got}`);
  }
}

console.log('\nroom geometry is decided by the file, not by its name');
{
  check('a wall is architecture', disciplineFor('walls') === 'architecture');
  check('a region is architecture', disciplineFor('region') === 'architecture');
  check('a dimension is annotation', disciplineFor('annotation') === 'annotation');
  check(
    'a named placement follows its name',
    disciplineFor('furniture', 'PTZ Camera') === 'video',
    disciplineFor('furniture', 'PTZ Camera'),
  );
  check(
    'unowned free geometry is scenic, not seating',
    disciplineFor('other') === 'drape',
    disciplineFor('other'),
  );
}

console.log('\nweight and power add up, and say what they could not count');
{
  const item = (name: string, weightLb?: number, powerW?: number): PlacedItem =>
    ({
      nodeId: 0,
      key: `${name}@0,0`,
      name,
      x: 0,
      y: 0,
      rotation: 0,
      width: 120,
      depth: 120,
      elevation: 0,
      top: 0,
      obstruction: 'none',
      seats: 0,
      spec: { id: name, name, weightLb, powerW },
    }) as unknown as PlacedItem;

  const items = [
    item('Chain Motor', 105, 0),
    item('Chain Motor', 105, 0),
    item('Box Truss', 80),
    item('Mac 600 Moving Light', 62, 600),
    item('Mac 600 Moving Light', 62, 600),
    item('Audio Console', 40, 300),
    item('Round 66"', undefined, undefined), // no figures at all
    item('Round 66"', undefined, undefined),
  ];

  const load = summariseLoad(items, defaultLayers(), {});

  check(
    'the total weight is the sum of what is rated',
    load.totalWeightLb === 105 + 105 + 80 + 62 + 62 + 40,
    `${load.totalWeightLb} lb`,
  );
  check('the total power is the sum of what draws', load.totalPowerW === 1500, `${load.totalPowerW} W`);
  check(
    'unrated items are reported, not silently treated as zero',
    load.unknown === 2,
    `${load.unknown} unrated`,
  );
  check(
    'amps are derived at 120V single phase',
    Math.abs(load.ampsAt120V - 12.5) < 1e-9,
    `${load.ampsAt120V} A`,
  );

  const rigging = load.lines.find((l) => l.layer === 'Rigging');
  check('rigging carries the motors and the truss', rigging?.weightLb === 290, `${rigging?.weightLb} lb`);
  check('and draws nothing', rigging?.powerW === 0, `${rigging?.powerW} W`);

  const lighting = load.lines.find((l) => l.layer === 'Lighting');
  check('lighting carries the movers', lighting?.powerW === 1200, `${lighting?.powerW} W`);

  const seating = load.lines.find((l) => l.layer === 'Seating');
  check(
    'seating reports two unrated items and no false total',
    seating?.unknown === 2 && seating?.weightLb === 0 && seating?.counted === 0,
    JSON.stringify(seating),
  );

  check('an empty plan totals nothing without throwing', summariseLoad([], defaultLayers(), {}).totalWeightLb === 0);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
