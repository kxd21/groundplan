/**
 * Multi-select rotate must orbit about the selection centre so angled seating
 * banks move as one piece — not each icon spinning on a fixed grid.
 */
import { indexDocument, nodeCentre, rotateNode, rotateNodeAbout } from '../src/format/edit.js';
import { fixtureDocument } from './test-fixture.js';

function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const doc = fixtureDocument();
const index = indexDocument(doc);
const shapes = [...index.byId.values()].filter(
  (n) => n.cls === 'RVShape' && n.bounds && n.bounds.right > n.bounds.left,
);

if (shapes.length < 2) {
  // Fixture may only hold one shape — still prove single-item rotate in place.
  check('fixture has a placed shape to rotate', shapes.length >= 1, `found ${shapes.length}`);
  const only = shapes[0];
  if (only) {
    const before = { ...nodeCentre(only)! };
    const r = rotateNode(doc, only, Math.PI / 6);
    const after = nodeCentre(only)!;
    const drift = Math.hypot(before.x - after.x, before.y - after.y);
    check('rotateNode still spins a single item in place', r.ok && drift < 5, `drift=${drift.toFixed(2)}`);
  }
} else {
  const a = shapes[0]!;
  const b = shapes[1]!;
  const ca0 = nodeCentre(a)!;
  const cb0 = nodeCentre(b)!;
  const pivot = { x: (ca0.x + cb0.x) / 2, y: (ca0.y + cb0.y) / 2 };
  const rad = Math.PI / 2;

  const r1 = rotateNodeAbout(doc, a, rad, pivot);
  const ca1 = nodeCentre(a)!;
  const ax0 = ca0.x - pivot.x;
  const ay0 = ca0.y - pivot.y;
  const expectAx = pivot.x + ax0 * Math.cos(rad) - ay0 * Math.sin(rad);
  const expectAy = pivot.y + ax0 * Math.sin(rad) + ay0 * Math.cos(rad);
  const dist = Math.hypot(ca1.x - expectAx, ca1.y - expectAy);
  check('rotateNodeAbout orbits around the pivot', r1.ok && dist < 3, `dist=${dist.toFixed(2)}`);

  const before = { ...nodeCentre(b)! };
  const r2 = rotateNode(doc, b, Math.PI / 6);
  const after = nodeCentre(b)!;
  const drift = Math.hypot(before.x - after.x, before.y - after.y);
  check('rotateNode still spins a single item in place', r2.ok && drift < 5, `drift=${drift.toFixed(2)}`);
}

if (!process.exitCode) console.log('all rotate-about checks passed');
