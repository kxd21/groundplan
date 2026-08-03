/**
 * Dimension types beyond a straight measurement, and drawing them into a plan
 * that has never been dimensioned.
 *
 *   npx tsx tools/dimension-test.ts
 */

import { loadBuffer, walk, UNITS_PER_FOOT } from '../src/format/index.js';
import { packContainer, verifyWritable } from '../src/format/write.js';
import { indexDocument } from '../src/format/edit.js';
import {
  annotationCapabilities,
  createDimension,
  createLabel,
  formatDistance,
} from '../src/format/annotate.js';
import { createBlankPlan } from '../src/format/blank.js';
import {
  alignedDimension,
  angleDimension,
  arcDimension,
  diameterDimension,
  dimensionCorners,
  dimensionRoom,
  linearDimension,
  radiusDimension,
} from '../src/format/dimension.js';
import { renderDimension, renderDimensions } from '../src/format/dimension-render.js';
import { setWallRadius } from '../src/format/room-edit.js';
import { rectangularRoom, roomFromPolygon, wall, wallLength } from '../src/format/room.js';
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
const FIXTURE = fixturePlanBuffer();
const countClass = (doc: Parameters<typeof walk>[0], cls: string) =>
  [...walk(doc)].filter((n) => n.cls === cls).length;

// ---------------------------------------------------------------------------
console.log('measurement text\n');

check('imperial keeps the sheet format', formatDistance(22 * F) === '22 ft  0 in');
check('inches round properly', formatDistance(22 * F + 60) === '22 ft  6 in');
check('twelve inches carries a foot', formatDistance(22 * F + 119) === '23 ft  0 in', formatDistance(22 * F + 119));
check('metric reads as metres', formatDistance(4 * F, 'metric').endsWith('m'), formatDistance(4 * F, 'metric'));

// ---------------------------------------------------------------------------
console.log('\ndimension types\n');

{
  const a = { x: 0, y: 0 };
  const b = { x: 40 * F, y: 0 };

  const aligned = alignedDimension(a, b)!;
  check('an aligned dimension measures the true distance', near(aligned.value, 40 * F));
  check('it draws a line and two witnesses', aligned.lines.length === 3);
  check('and reads 40 ft', aligned.text === '40 ft  0 in', aligned.text);

  const diagonal = alignedDimension({ x: 0, y: 0 }, { x: 30 * F, y: 40 * F })!;
  check('a diagonal measures 50 ft', near(diagonal.value, 50 * F), `${diagonal.value / F}`);

  const horizontal = linearDimension({ x: 0, y: 0 }, { x: 30 * F, y: 40 * F }, 'horizontal')!;
  check('a horizontal dimension measures only across', near(horizontal.value, 30 * F));
  const vertical = linearDimension({ x: 0, y: 0 }, { x: 30 * F, y: 40 * F }, 'vertical')!;
  check('a vertical dimension measures only down', near(vertical.value, 40 * F));
  check('two identical points cannot be dimensioned', linearDimension(a, a, 'horizontal') === null);
}

{
  // The curved cases — the ones that were missing entirely.
  const bay = wall({ x: 0, y: 0 }, { x: 40 * F, y: 0 }, Math.tan(Math.PI / 8));

  const radius = radiusDimension(bay)!;
  check('a curved wall has a radius dimension', !!radius);
  check('its leader runs from the centre to the arc', radius.lines[0].length === 2);
  check('the leader is exactly one radius long', near(Math.hypot(
    radius.lines[0][1].x - radius.lines[0][0].x,
    radius.lines[0][1].y - radius.lines[0][0].y,
  ), radius.value, 1e-6));
  check('and it is labelled as a radius', radius.text.startsWith('R '), radius.text);

  const diameter = diameterDimension(bay)!;
  check('a diameter is twice the radius', near(diameter.value, radius.value * 2, 1e-9));
  check('it is labelled DIA, not a symbol the format cannot store', diameter.text.startsWith('DIA '), diameter.text);
  check('every character survives latin-1', Buffer.from(diameter.text, 'latin1').toString('latin1') === diameter.text);

  const arc = arcDimension(bay)!;
  check('an arc dimension measures along the curve', near(arc.value, wallLength(bay), 1e-9));
  check('which is longer than the chord', arc.value > 40 * F);
  check('and it draws the curve itself', arc.lines[0].length > 2);

  const straight = wall({ x: 0, y: 0 }, { x: 100, y: 0 });
  check('a straight wall has no radius', radiusDimension(straight) === null);
  check('a straight wall has no arc length', arcDimension(straight) === null);
}

{
  // Angles.
  const square = angleDimension({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 })!;
  check('a square corner measures 90 degrees', near(square.value, 90, 1e-9), `${square.value}`);
  check('the degree sign survives latin-1', Buffer.from(square.text, 'latin1').toString('latin1') === square.text);
  check('it reads as a whole number', square.text === '90°', square.text);

  const splay = angleDimension({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 })!;
  check('a 45 degree splay measures 45', near(splay.value, 45, 1e-9), `${splay.value}`);
  check('an angle draws an arc between two rays', splay.lines.length === 3 && splay.lines[0].length > 3);

  // A reflex corner is reported as the angle a person means, not 300 degrees.
  const reflex = angleDimension({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: -87 })!;
  check('a corner is never reported as reflex', reflex.value <= 180, `${reflex.value}`);
  check('two identical directions cannot make an angle', angleDimension({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }) === null);
}

// ---------------------------------------------------------------------------
console.log('\ndimensioning a whole room\n');

{
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  const dims = dimensionRoom(room);
  check('every wall gets a dimension', dims.length === 4, `${dims.length}`);
  check(
    'and they total the perimeter',
    near(dims.reduce((sum, d) => sum + d.value, 0), 140 * F, 1e-6),
  );
  check('a square room has no corner angles worth drawing', dimensionCorners(room).length === 0);

  const bowed = setWallRadius(room, 0, 40 * F).room!;
  const bowedDims = dimensionRoom(bowed);
  check('a curved wall is dimensioned by its radius', bowedDims[0].kind === 'radius', bowedDims[0].kind);
  check('and the straight ones still by length', bowedDims.filter((d) => d.kind === 'aligned').length === 3);

  const angled = roomFromPolygon([
    { x: 0, y: 0 },
    { x: 40 * F, y: 0 },
    { x: 30 * F, y: 30 * F },
    { x: 0, y: 30 * F },
  ]);
  const cornerDims = dimensionCorners(angled);
  check('an angled room reports its non-square corners', cornerDims.length === 2, `${cornerDims.length}`);
  check('all under 180 degrees', cornerDims.every((d) => d.value < 180));
}

// ---------------------------------------------------------------------------
console.log('\ndrawing dimensions into a plan\n');

{
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const room = rectangularRoom(40 * F, 30 * F, 'Hall');
  const curved = setWallRadius(room, 0, 40 * F).room!;

  const drawn = renderDimensions(doc, dimensionRoom(curved));
  check('a fully dimensioned room draws', drawn.ok, drawn.reason);
  check('four dimensions produce four labels', countClass(doc, 'RVLabel') === 1 + 4, `${countClass(doc, 'RVLabel')}`);

  const verdict = verifyWritable(doc);
  check('the dimensioned plan verifies', verdict.ok, verdict.reason);

  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'dimensioned.rv4').document;
  check('the labels survive the round trip', countClass(reread, 'RVLabel') === 5, `${countClass(reread, 'RVLabel')}`);
  const texts = [...walk(reread)].filter((n) => n.cls === 'RVLabel').flatMap((n) => n.labels);
  check('the radius label reads back', texts.some((t) => t.startsWith('R ')), texts.join(' | '));
  check('a length label reads back', texts.some((t) => t === '30 ft  0 in'), texts.join(' | '));
}

{
  // An angle dimension is a polyline plus two leaders plus a label.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  const angle = angleDimension({ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 })!;
  const drawn = renderDimension(doc, angle);
  check('an angle dimension draws', drawn.ok, drawn.reason);
  check('as four objects', drawn.created.length === 4, `${drawn.created.length}`);

  const verdict = verifyWritable(doc);
  check('and verifies', verdict.ok, verdict.reason);
  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'angle.rv4').document;
  const degrees = [...walk(reread)].filter((n) => n.cls === 'RVLabel').flatMap((n) => n.labels);
  check('the degree text survives the file', degrees.includes('90°'), degrees.join(' | '));
}

{
  // The case that used to be refused: a plan with nothing to copy.
  const doc = loadBuffer(FIXTURE, 'fixture.rv4').document;
  for (const node of walk(doc)) {
    if (node.cls === 'RVLabel') node.fields.textAt = undefined;
  }
  const madeLabel = createLabel(doc, indexDocument(doc), 'Built from nothing', 500, 500);
  check('a label can be made with no template to copy', madeLabel.ok, madeLabel.reason);

  const madeDimension = createDimension(doc, indexDocument(doc), 0, 0, 40 * F, 0);
  check('so can a dimension', madeDimension.ok, madeDimension.reason);

  const verdict = verifyWritable(doc);
  check('the result verifies', verdict.ok, verdict.reason);
  const reread = loadBuffer(packContainer(FIXTURE, verdict.bytes!), 'scratch.rv4').document;
  const texts = [...walk(reread)].filter((n) => n.cls === 'RVLabel').flatMap((n) => n.labels);
  check('the synthesized text reads back', texts.includes('Built from nothing'), texts.join(' | '));
  check('with a font name beside it', texts.includes('Arial'), texts.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\nannotating a plan drawn from scratch\n');

{
  // `annotationCapabilities` reports whether new annotation will match the
  // sheet's existing styling — not whether it can be made at all. A plan built
  // from nothing has neither template, and both must still work: the renderer
  // once read these flags as permission, which left the label and dimension
  // tools permanently disabled in every plan drawn from scratch.
  const blank = createBlankPlan({ room: { width: 120 * F, depth: 80 * F }, roomName: 'Main' });
  check('a blank plan is built', blank.ok, blank.reason);
  const doc = loadBuffer(blank.file!, 'blank.rv4').document;

  const caps = annotationCapabilities(doc);
  check('it reports no styling to copy', !caps.label && !caps.dimension);

  let labelFailure = '';
  let dimensionFailure = '';
  for (let i = 0; i < 43 && !labelFailure; i++) {
    const made = createLabel(
      doc,
      indexDocument(doc),
      `Label ${i + 1}`,
      (i % 10) * 5 * F,
      Math.floor(i / 10) * 5 * F,
    );
    const verdict = verifyWritable(doc);
    if (!made.ok || !verdict.ok) labelFailure = `#${i + 1}: ${made.reason ?? verdict.reason}`;
  }
  check('forty-three labels in a row all land', !labelFailure, labelFailure);

  for (let i = 0; i < 43 && !dimensionFailure; i++) {
    const x = (i % 10) * 6 * F;
    const y = 100 * F + Math.floor(i / 10) * 6 * F;
    const made = createDimension(doc, indexDocument(doc), x, y, x + 12 * F, y);
    const verdict = verifyWritable(doc);
    if (!made.ok || !verdict.ok) dimensionFailure = `#${i + 1}: ${made.reason ?? verdict.reason}`;
  }
  check('and so do forty-three dimensions', !dimensionFailure, dimensionFailure);

  check(
    'the lines are all there',
    countClass(doc, 'RVDimensionLine') === 43,
    String(countClass(doc, 'RVDimensionLine')),
  );
  // 43 placed labels, plus the measurement text each dimension carries.
  check(
    'with a label apiece beside them',
    countClass(doc, 'RVLabel') === 86,
    String(countClass(doc, 'RVLabel')),
  );
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) process.exit(1);
