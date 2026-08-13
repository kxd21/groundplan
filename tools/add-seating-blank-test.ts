/**
 * Blank-plan theatre seating must place a full block after the first chair is
 * synthesized (stale-index regression) and honour inventory footprints.
 *
 *   npx tsx tools/add-seating-blank-test.ts
 */
import { loadBuffer } from '../src/format/index.js';
import { createBlankPlan } from '../src/format/blank.js';
import { indexDocument } from '../src/format/edit.js';
import { addSeating } from '../src/format/seating.js';
import { UNITS_PER_INCH } from '../src/format/constants.js';

const F = 120;
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

{
  const blank = createBlankPlan({ room: { width: 245 * F, depth: 130.583 * F } });
  if (!blank.ok || !blank.file) throw new Error(blank.reason || 'blank failed');
  const doc = loadBuffer(blank.file, 'new.rv4').document;
  const index = indexDocument(doc);
  const result = addSeating(doc, index, {
    kind: 'theatre',
    chair: 'Chair 20.5W X 23.23D',
    rows: 10,
    perRow: 11,
    x: -107.5 * F,
    y: -36.3 * F,
    angle: 30,
    chairSize: { width: 20.5 * UNITS_PER_INCH, height: 23.23 * UNITS_PER_INCH },
  });
  check('blank theatre block succeeds', result.ok, result.reason);
  check('places every seat', result.placed === 110, `${result.placed}`);
  check('creates geometry for each seat', (result.created?.length ?? 0) >= 110, `${result.created?.length}`);
}

{
  const blank = createBlankPlan({ room: { width: 80 * F, depth: 50 * F } });
  if (!blank.ok || !blank.file) throw new Error(blank.reason || 'blank failed');
  const doc = loadBuffer(blank.file, 'new.rv4').document;
  const lengths = [12, 13, 14, 14, 14, 14, 13, 13, 13, 13, 13];
  const want = lengths.reduce((a, b) => a + b, 0);
  const result = addSeating(doc, indexDocument(doc), {
    kind: 'theatre',
    chair: 'Chair 20.5W X 23.23D',
    x: 0,
    y: 0,
    rowLengths: lengths,
    seatSpacing: 1.79 * F,
    rowSpacing: 3.5 * F,
    chairSize: { width: 20.5 * UNITS_PER_INCH, height: 23.23 * UNITS_PER_INCH },
  });
  check('irregular rowLengths succeeds', result.ok, result.reason);
  check('irregular block places exact seat count', result.placed === want, `${result.placed} vs ${want}`);
}

{
  const blank = createBlankPlan({ room: { width: 60 * F, depth: 40 * F } });
  if (!blank.ok || !blank.file) throw new Error(blank.reason || 'blank failed');
  const doc = loadBuffer(blank.file, 'new.rv4').document;
  const result = addSeating(doc, indexDocument(doc), {
    kind: 'theatre',
    chair: 'Chair',
    rows: 2,
    perRow: 3,
    x: 0,
    y: 0,
    angle: -30,
  });
  check('small angled block succeeds', result.ok, result.reason);
  check('small angled block places 6', result.placed === 6, `${result.placed}`);
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} failed` : `${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
