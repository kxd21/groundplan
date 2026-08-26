/**
 * The controls must describe the object you can see.
 *
 *   npx tsx tools/oriented-extent-test.ts
 *
 * Properties reported a placed item using two numbers that were both wrong for
 * anything not axis-aligned:
 *
 *   - the angle came from `node.angle`, which `rotateNode` uses as a running
 *     total of the turns applied since placement rather than an absolute facing,
 *   - the size came from `measureNode`, which returns the axis-aligned box.
 *
 * In a real 2,234-seat show that made a 20.5x23.2in chair drawn at -120 degrees
 * report "0 degrees, 30.4 x 29.4in" — and one that had been turned repeatedly
 * report "512 degrees". Worse, `resizeNode` scaled on world axes, so asking that
 * chair to double its width returned 27.1x41.9in with 123-degree corners: a
 * parallelogram. The controls did not just describe the object wrongly, they
 * destroyed it.
 *
 * So this asserts the recovered rectangle, and that a resize of a rotated object
 * stays a rectangle.
 */
import { createBlankPlan } from '../src/format/blank.js';
import { loadBuffer } from '../src/format/index.js';
import { UNITS_PER_FOOT, walk, type RVNode } from '../src/format/rv.js';
import { indexDocument, measureNode, orientedExtent, resizeNode, rotateNode } from '../src/format/edit.js';
import { placeGear } from '../src/format/place.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

const blank = createBlankPlan({ room: { width: 60 * UNITS_PER_FOOT, depth: 40 * UNITS_PER_FOOT } });
if (!blank.ok || !blank.file) throw new Error(`blank plan failed: ${blank.reason}`);
const doc = loadBuffer(blank.file, 'oriented.rv4').document;

const placed = placeGear(doc, indexDocument(doc), 'Riser 8ft x 4ft', 10 * UNITS_PER_FOOT, 10 * UNITS_PER_FOOT, {
  width: 8 * UNITS_PER_FOOT,
  height: 4 * UNITS_PER_FOOT,
});
ok('a riser places on a blank plan', placed.ok, placed.reason);

const node = [...walk(doc)].filter((n: RVNode) => n.cls === 'RVShape').at(-1)!;
const ft = (u: number) => u / UNITS_PER_FOOT;

const flat = orientedExtent(node);
ok('an unrotated riser measures 8ft x 4ft', !!flat && near(ft(flat.width), 8) && near(ft(flat.height), 4),
  flat ? `${ft(flat.width).toFixed(2)} x ${ft(flat.height).toFixed(2)}` : 'not recovered');
ok('and reads as 0 degrees', !!flat && near((flat.angleRadians * 180) / Math.PI, 0));

// Turn it the way a chair in the Card Party plan is turned.
const turn = (-120 * Math.PI) / 180;
ok('it rotates', rotateNode(doc, node, turn).ok);

const turned = orientedExtent(node);
ok('a turned riser still measures 8ft x 4ft',
  !!turned && near(ft(turned.width), 8) && near(ft(turned.height), 4),
  turned ? `${ft(turned.width).toFixed(2)} x ${ft(turned.height).toFixed(2)}` : 'not recovered');
ok('and reports the angle it is drawn at, not the turns applied',
  !!turned && near((turned.angleRadians * 180) / Math.PI, -120, 0.1),
  turned ? `${((turned.angleRadians * 180) / Math.PI).toFixed(1)} deg` : 'not recovered');

// The axis-aligned box is a different, larger number — which is the whole point.
const box = measureNode(node);
// A -120 degree turn of an 8x4 boxes to 7.46 x 8.93: narrower AND taller, so
// the box is not a scaled version of the object — it is a different rectangle.
ok('the axis-aligned box is a different rectangle, so it cannot stand in for the object',
  ft(box.width) * ft(box.height) > 8 * 4 * 1.5 && !near(ft(box.width), 8, 0.2),
  `${ft(box.width).toFixed(2)} x ${ft(box.height).toFixed(2)} vs 8.00 x 4.00`);

/** The corner angle between the first two edges of the outline, in degrees. */
const findRect = (n: RVNode): RVNode | undefined => {
  if (n.points.length === 4 || n.points.length === 5) return n;
  for (const c of n.children) { const hit = findRect(c); if (hit) return hit; }
  return undefined;
};
const cornerOf = (n: RVNode): number => {
  const rect = findRect(n);
  if (!rect) return Number.NaN;
  const p = rect.points;
  const e0 = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
  const e1 = { x: p[2].x - p[1].x, y: p[2].y - p[1].y };
  return (Math.acos((e0.x * e1.x + e0.y * e1.y) / (Math.hypot(e0.x, e0.y) * Math.hypot(e1.x, e1.y))) * 180) / Math.PI;
};
ok('the turned riser is still square-cornered', near(cornerOf(node), 90, 0.5), `${cornerOf(node).toFixed(2)} deg`);

// Double the width the way the Properties width box does.
ok('it resizes', resizeNode(doc, node, 2, 1).ok);
const wide = orientedExtent(node);
ok('doubling the width of a turned riser gives 16ft x 4ft',
  !!wide && near(ft(wide.width), 16) && near(ft(wide.height), 4),
  wide ? `${ft(wide.width).toFixed(2)} x ${ft(wide.height).toFixed(2)}` : 'not recovered');
ok('and it is still a rectangle, not a parallelogram', near(cornerOf(node), 90, 0.5), `${cornerOf(node).toFixed(2)} deg`);
ok('and it kept its angle', !!wide && near((wide.angleRadians * 180) / Math.PI, -120, 0.1));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
