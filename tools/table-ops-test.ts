/**
 * Table stamp / redistribute / auto-number helpers.
 *
 *   npx tsx tools/table-ops-test.ts
 */
import { loadBuffer } from '../src/format/index.js';
import { createBlankPlan } from '../src/format/blank.js';
import { indexDocument, measureNode, nodeCentre } from '../src/format/edit.js';
import { UNITS_PER_INCH } from '../src/format/constants.js';
import {
  autoNumberTables,
  redistributeChairsAroundTable,
  stampTableGrid,
  tableGridDeltas,
} from '../src/format/table-ops.js';

const F = 120;
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

{
  const blank = createBlankPlan({ room: { width: 80 * F, depth: 60 * F } });
  if (!blank.ok || !blank.file) throw new Error(blank.reason || 'blank failed');
  const doc = loadBuffer(blank.file, 'tables.rv4').document;
  const stamp = stampTableGrid(doc, indexDocument(doc), {
    x: 0,
    y: 0,
    columns: 2,
    rows: 2,
    spacingX: 12 * F,
    spacingY: 12 * F,
    table: '60" Round',
    chair: 'Chair',
    seats: 8,
    tableSize: { width: 60 * UNITS_PER_INCH, height: 60 * UNITS_PER_INCH },
    chairSize: { width: 20 * UNITS_PER_INCH, height: 20 * UNITS_PER_INCH },
  });
  check('stamp 2×2 succeeds', stamp.ok, stamp.reason);
  check('stamp places 4 tables', (stamp.tableIds?.length ?? 0) === 4, `${stamp.tableIds?.length}`);
  check(
    'stamp places 4×8 chairs + tables',
    (stamp.placed ?? 0) === 4 * 9,
    `${stamp.placed}`,
  );

  const tableId = stamp.tableIds?.[0];
  const oldChairs = stamp.chairIdsByTable?.[0] ?? [];
  check('first table has chairs', !!tableId && oldChairs.length === 8, `${oldChairs.length}`);

  if (tableId != null) {
    const redist = redistributeChairsAroundTable(
      doc,
      indexDocument(doc),
      tableId,
      6,
      'Chair',
      oldChairs,
      { chairSize: { width: 20 * UNITS_PER_INCH, height: 20 * UNITS_PER_INCH } },
    );
    check('redistribute to 6 succeeds', redist.ok, redist.reason);
    check('redistribute creates 6 chairs', (redist.chairIds?.length ?? 0) === 6, `${redist.chairIds?.length}`);
  }

  const numbered = autoNumberTables(doc, indexDocument(doc), stamp.tableIds ?? [], {
    start: 10,
    order: 'left-right',
  });
  check('auto-number succeeds', numbered.ok, numbered.reason);
  check('auto-number creates 4 labels', (numbered.labelIds?.length ?? 0) === 4, `${numbered.labelIds?.length}`);

  const deltas = tableGridDeltas(doc, stamp.tableIds ?? [], 14 * F, 14 * F);
  check('table grid deltas ok', deltas.ok, !deltas.ok ? deltas.reason : undefined);
  if (deltas.ok) {
    check('spacing moves some tables', deltas.moves.length >= 1, `${deltas.moves.length}`);
  }

  // Centres of a 2×2 stamp should be 12' apart on a side.
  if (stamp.tableIds && stamp.tableIds.length === 4) {
    const centres = stamp.tableIds.map((id) => {
      const node = indexDocument(doc).byId.get(id)!;
      return nodeCentre(node)!;
    });
    const xs = [...new Set(centres.map((c) => Math.round(c.x)))].sort((a, b) => a - b);
    const ys = [...new Set(centres.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
    check('two distinct X centres', xs.length === 2, `${xs.join(',')}`);
    check('two distinct Y centres', ys.length === 2, `${ys.join(',')}`);
    if (xs.length === 2 && ys.length === 2) {
      check('X spacing ~12\'', Math.abs(xs[1]! - xs[0]!) - 12 * F < 2, `${xs[1]! - xs[0]!}`);
      check('Y spacing ~12\'', Math.abs(ys[1]! - ys[0]!) - 12 * F < 2, `${ys[1]! - ys[0]!}`);
    }
    const first = indexDocument(doc).byId.get(stamp.tableIds[0]!);
    if (first) {
      const size = measureNode(first);
      check('table has size', size.width > 0 && size.height > 0, `${size.width}x${size.height}`);
    }
  }
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} failed` : `${checks.length}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
