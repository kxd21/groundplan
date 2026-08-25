/**
 * LED walls: panels in, everything else out.
 *
 *   npx tsx tools/led-test.ts
 *
 * A wall is an integer number of cabinets. Every number that matters — size,
 * resolution, aspect, weight, draw, processor count — follows from that, and
 * none of it should be rounded to look tidy.
 */

import {
  describeAspect,
  fitWall,
  PANEL_TYPES,
  panelSpec,
  solveWall,
  unitsToFeet,
  wallBuildList,
} from '../src/format/led.js';

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

console.log('\nthe catalogue is coherent');
{
  check('every panel has a unique id', new Set(PANEL_TYPES.map((p) => p.id)).size === PANEL_TYPES.length);
  for (const panel of PANEL_TYPES) {
    // Pixels across a cabinet must agree with its size and pitch, or every
    // resolution downstream is wrong.
    const impliedWide = panel.widthMm / panel.pitchMm;
    const impliedHigh = panel.heightMm / panel.pitchMm;
    check(
      `${panel.label} pixel count matches its pitch`,
      Math.abs(impliedWide - panel.pixelsWide) <= 1.5 && Math.abs(impliedHigh - panel.pixelsHigh) <= 1.5,
      `stated ${panel.pixelsWide}×${panel.pixelsHigh}, implied ${impliedWide.toFixed(1)}×${impliedHigh.toFixed(1)}`,
    );
  }
}

console.log('\na 16:9 wall in 3.9mm');
{
  // 20 across x 9 down of 500x500 at 3.9mm: 2560x1152 — a real 20:9 wall.
  const wall = solveWall({ panel: 'p3.9-500', columns: 20, rows: 9 })!;
  check('it solves', !!wall);
  check('panels multiply out', wall.panels === 180, `${wall.panels}`);
  check('native resolution is exact', wall.pixelsWide === 2560 && wall.pixelsHigh === 1152, `${wall.pixelsWide}×${wall.pixelsHigh}`);
  check(
    'physical size is exact, not rounded',
    wall.widthMm === 10000 && wall.heightMm === 4500,
    `${wall.widthMm}×${wall.heightMm}mm`,
  );
  check(
    'and converts to feet correctly',
    Math.abs(unitsToFeet(wall.width) - 10000 / 304.8) < 0.01,
    `${unitsToFeet(wall.width).toFixed(2)}ft`,
  );
  check('weight is per panel', wall.weightLb === 180 * 16, `${wall.weightLb}`);
  check('draw is per panel', wall.powerW === 180 * 120, `${wall.powerW}`);
  check(
    'amps are quoted at 208V, which is what a wall is fed',
    Math.abs(wall.ampsAt208V - (180 * 120) / 208) < 1e-9,
    `${wall.ampsAt208V.toFixed(1)}A`,
  );
}

console.log('\naspect is named only when it really is one');
{
  check('16:9 is recognised', describeAspect(16 / 9) === '16:9');
  check('4:3 is recognised', describeAspect(4 / 3) === '4:3');
  check('1:1 is recognised', describeAspect(1) === '1:1');
  check('3:2 is recognised', describeAspect(3 / 2) === '3:2');
  check(
    'an odd ratio is reported as a number, not fudged to 16:9',
    describeAspect(1.833) === '1.83:1',
    describeAspect(1.833),
  );

  // 11 x 6 of 500x500 is 1.833:1 — close to 16:9 and not 16:9.
  const odd = solveWall({ panel: 'p3.9-500', columns: 11, rows: 6 })!;
  check('an 11×6 wall is not called 16:9', odd.aspectLabel !== '16:9', odd.aspectLabel);
  check(
    'and warns that content has to be built to size',
    odd.warnings.some((w) => /not a standard delivery ratio/.test(w)),
    odd.warnings.join(' | '),
  );

  // 500x500 at 3.9mm is 128x128px a cabinet, so 16 across by 9 down really is
  // 16:9. The same 16x9 in a 500x1000 cabinet is a portrait wall — the panel
  // shape decides the aspect, not the panel count.
  const clean = solveWall({ panel: 'p3.9-500', columns: 16, rows: 9 })!;
  check(
    'a wall whose pixels really are 16:9 is named 16:9',
    clean.aspectLabel === '16:9',
    `${clean.pixelsWide}×${clean.pixelsHigh} → ${clean.aspectLabel}`,
  );
}

console.log('\nthe warnings are the ones worth interrupting for');
{
  const huge = solveWall({ panel: 'p2.6-500x1000', columns: 40, rows: 8 })!;
  check(
    'a heavy wall raises the rigging question',
    huge.warnings.some((w) => /rigging points/.test(w)),
    huge.warnings.join(' | '),
  );
  check(
    'a wall over 4K raises the processor question',
    huge.pixels > 3840 * 2160 && huge.warnings.some((w) => /4K processor/.test(w)),
    `${huge.pixels.toLocaleString()} px`,
  );

  const coarse = solveWall({ panel: 'p6-500x1000', columns: 8, rows: 4 })!;
  check(
    'a coarse pitch raises the front-row question',
    coarse.warnings.some((w) => /front row/.test(w)),
    coarse.warnings.join(' | '),
  );

  // 4x3 of 500x500 is 512x384px — a clean 4:3, 12 panels, 192lb. Nothing here
  // is worth interrupting anybody about.
  const modest = solveWall({ panel: 'p3.9-500', columns: 4, rows: 3 })!;
  check('a genuinely small wall warns about nothing', modest.warnings.length === 0, modest.warnings.join(' | '));
  check('and is named 4:3', modest.aspectLabel === '4:3', modest.aspectLabel);
}

console.log('\nfitting to a wanted size never overruns it');
{
  const FT = 120;
  // 20ft wide of a 500mm panel is 12.19 panels — so 12, and under 20ft.
  const wall = fitWall('p3.9-500', 20 * FT, 10 * FT)!;
  check('it fits whole panels only', Number.isInteger(wall.columns) && Number.isInteger(wall.rows));
  check('and never exceeds the target', wall.width <= 20 * FT && wall.height <= 10 * FT,
    `${unitsToFeet(wall.width).toFixed(2)} × ${unitsToFeet(wall.height).toFixed(2)} ft`);
  check('columns are as many as fit', wall.columns === 12, `${wall.columns}`);
  check('a target smaller than one panel still builds one', fitWall('p3.9-500', 10, 10)!.panels === 1);
  check('an unknown panel returns nothing rather than guessing', fitWall('nope', 20 * FT, 10 * FT) === null);
  check('an unknown panel id does not resolve', panelSpec('nope') === undefined);
}

console.log('\nthe build list is orderable');
{
  const wall = solveWall({ panel: 'p3.9-500x1000', columns: 16, rows: 9 })!;
  const list = wallBuildList(wall);
  const panels = list.find((l) => l.item.startsWith('LED panel'));
  check('panels are on it', panels?.quantity === 144, `${panels?.quantity}`);
  check('bumpers are one per column', list.find((l) => l.item === 'Hanging bumper')?.quantity === 16);

  const spares = list.find((l) => l.item === 'Spare panels')!;
  check('spares are whole panels, rounded up', spares.quantity === Math.ceil(144 * 0.03), `${spares.quantity}`);

  const cases = list.find((l) => l.item === 'Panel case')!;
  check(
    'cases hold six of a 500×1000 cabinet',
    cases.quantity === Math.ceil((144 + spares.quantity) / 6),
    `${cases.quantity}`,
  );

  const processors = list.find((l) => l.item === 'Processor')!;
  check('at least one processor is always listed', processors.quantity >= 1, `${processors.quantity}`);
  check(
    'and the count follows the pixel budget',
    processors.quantity === Math.max(1, Math.ceil(wall.fractionOf4k)),
    `${wall.pixels.toLocaleString()} px → ${processors.quantity}`,
  );

  const small = wallBuildList(solveWall({ panel: 'p3.9-500', columns: 4, rows: 3 })!);
  check(
    'a small wall still gets at least one spare',
    small.find((l) => l.item === 'Spare panels')!.quantity >= 1,
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
