/**
 * Export line weights hold up at the scale the drawing is actually read at.
 *
 *   npx tsx tools/export-scale-test.ts
 *
 * Weights are stated in printed points and converted into drawing units for a
 * particular scale. A named architectural scale is knowable up front; "Fit to
 * page" is not — the drawing is shrunk to the frame and the scale is whatever
 * that shrinking produced. Sizing strokes for a nominal 1/8in per foot and then
 * letting the sheet shrink the result is why a large ballroom exported as
 * hairlines: every line had been drawn for a sheet several times the size of
 * the one it went onto.
 *
 * The check that matters is the round trip: take the stroke width in drawing
 * units, apply the shrink the sheet will apply, and confirm what lands on paper
 * is the weight the style asked for.
 */

import {
  fitInchesPerFoot,
  GRADE,
  MIN_STROKE_POINTS,
  pointsToUnits,
  SCALE_INCHES_PER_FOOT,
  sheetFrame,
} from '../src/format/style.js';
import { toSvg } from '../src/renderer/src/svg.js';
import type { Scene } from '../src/format/scene.js';
import { LAYER_IDS } from '../src/format/layers.js';

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

const F = 120;

/** A room outline as a scene, so the exporter has real geometry to frame. */
function roomScene(widthFt: number, depthFt: number): Scene {
  const w = widthFt * F;
  const d = depthFt * F;
  return {
    primitives: [
      {
        type: 'polyline',
        layer: 'walls',
        pts: [0, 0, w, 0, w, d, 0, d, 0, 0],
        color: 0,
        cls: 'RVWall',
        discipline: 'architecture',
      },
    ],
    extent: { minX: 0, minY: 0, maxX: w, maxY: d },
    inventory: [],
  } as unknown as Scene;
}

/** The stroke width the SVG root declares, and the sheet size it is built for. */
function readSvg(svg: string): {
  stroke: number;
  widthIn: number;
  heightIn: number;
  viewBoxWidth: number;
} {
  const stroke = Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1] ?? NaN);
  const widthIn = Number(/\swidth="([\d.]+)in"/.exec(svg)?.[1] ?? NaN);
  const heightIn = Number(/\sheight="([\d.]+)in"/.exec(svg)?.[1] ?? NaN);
  const viewBoxWidth = Number(
    /viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)?.[1] ?? NaN,
  );
  return { stroke, widthIn, heightIn, viewBoxWidth };
}

// Production layers now, not the geometry layers the file stores.
const visible = new Set<string>(LAYER_IDS);

console.log('\nfit scale is derived, not assumed');
{
  const frame = sheetFrame('Letter', true);
  check(
    'a Letter landscape frame leaves 10.0 x 6.65in to draw in',
    Math.abs(frame.width - 10) < 1e-9 && Math.abs(frame.height - 6.65) < 1e-9,
    `${frame.width} x ${frame.height}`,
  );

  // Card Party South Florida is 245 x 130ft. Two feet of margin each side.
  const ipf = fitInchesPerFoot({ width: 249 * F, height: 134 * F }, frame);
  check(
    'a 245ft ballroom fitted to Letter lands near 1/25in per foot',
    ipf > 0.035 && ipf < 0.045,
    `${ipf.toFixed(5)} in/ft`,
  );
  check(
    'which is far coarser than the 1/8in the exporter used to assume',
    ipf < SCALE_INCHES_PER_FOOT['1/8']! / 2,
    `${ipf.toFixed(5)} vs ${SCALE_INCHES_PER_FOOT['1/8']}`,
  );

  // A room smaller than the frame fits at a scale LARGER than 1/8 — the old
  // assumption made those lines too heavy rather than too light.
  const small = fitInchesPerFoot({ width: 24 * F, height: 16 * F }, frame);
  check(
    'a 24ft boardroom fits at a scale larger than 1/8in per foot',
    small > SCALE_INCHES_PER_FOOT['1/8']!,
    `${small.toFixed(4)} in/ft`,
  );
}

console.log('\nwhat lands on paper is the weight that was asked for');
{
  const frame = sheetFrame('Letter', true);

  for (const [label, widthFt, depthFt] of [
    ['a 245ft ballroom', 245, 130],
    ['a 60ft meeting room', 60, 40],
    ['a 24ft boardroom', 24, 16],
  ] as const) {
    const svg = toSvg(roomScene(widthFt, depthFt), visible, 'fit', null, {
      paper: 'Letter',
      landscape: true,
    });
    const { stroke, widthIn, heightIn, viewBoxWidth } = readSvg(svg);

    // The sheet shrinks the drawing onto the frame, preserving aspect. Whatever
    // survives that shrink is what the eye sees. If the declared sheet size is
    // right, it already fits on one axis and nothing shrinks at all.
    const shrink = Math.min(frame.width / widthIn, frame.height / heightIn, 1);
    const printedPoints = (stroke / viewBoxWidth) * widthIn * shrink * 72;

    check(
      `${label} is exported at a size that already fits the frame`,
      Math.abs(shrink - 1) < 1e-6,
      `shrink ${shrink.toFixed(4)} — declared ${widthIn}x${heightIn}in into ${frame.width}x${frame.height}in`,
    );

    check(
      `${label} prints its heaviest line at the weight the style asks for`,
      Math.abs(printedPoints - GRADE.heavy) < 0.06,
      `${printedPoints.toFixed(3)}pt on paper, style asks ${GRADE.heavy}pt`,
    );
    check(
      `${label} never prints below the minimum stroke`,
      printedPoints >= MIN_STROKE_POINTS,
      `${printedPoints.toFixed(3)}pt`,
    );
  }
}

console.log('\nthe old behaviour is what was wrong');
{
  // Reproduce the pre-fix conversion: strokes sized for a nominal 1/8in.
  const frame = sheetFrame('Letter', true);
  const assumed = pointsToUnits(GRADE.heavy, SCALE_INCHES_PER_FOOT['1/8']!);
  const actual = pointsToUnits(GRADE.heavy, fitInchesPerFoot({ width: 249 * F, height: 134 * F }, frame));
  check(
    'the old conversion drew a 245ft ballroom at least three times too thin',
    actual / assumed > 3,
    `now ${actual.toFixed(1)} units vs then ${assumed.toFixed(1)} units`,
  );
}

console.log('\nnamed scales are unchanged');
{
  for (const id of ['1/16', '3/32', '1/8', '3/16', '1/4'] as const) {
    const svg = toSvg(roomScene(60, 40), visible, id, null, {
      paper: 'Letter',
      landscape: true,
    });
    const { stroke, widthIn, viewBoxWidth } = readSvg(svg);
    const printedPoints = (stroke / viewBoxWidth) * widthIn * 72;
    check(
      `${id}in = 1ft still prints its heaviest line at ${GRADE.heavy}pt`,
      Math.abs(printedPoints - GRADE.heavy) < 0.02,
      `${printedPoints.toFixed(3)}pt`,
    );
  }
}

console.log('\nthe root declares a real paper size');
{
  const svg = toSvg(roomScene(60, 40), visible, '1/4', null, {
    paper: 'Letter',
    landscape: true,
  });
  const { widthIn } = readSvg(svg);
  // 60ft plus two feet of margin each side, at 1/4in per foot.
  check(
    'a 60ft room at 1/4in per foot declares a 16in sheet',
    Math.abs(widthIn - 16) < 0.01,
    `${widthIn}in`,
  );
  check('and states the unit rather than a bare pixel count', / width="[\d.]+in"/.test(svg));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
