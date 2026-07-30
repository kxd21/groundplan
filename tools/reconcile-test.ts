/** Checks the gear-vs-plan comparison against a real job. */
import { readFileSync } from 'node:fs';
import { importGearPdf } from '../src/gear/import-pdf.js';
import { loadBuffer } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { reconcile } from '../src/gear/reconcile.js';

const PDF = '/Users/princedavidthompson/Downloads/Spring Gala 2026 - Example City.pdf';
const PLAN = '/Volumes/Prince/Roomviewer/Data/Riverbend Hall 2026 Main Stage - (Riverbend Convention Center).rv4';
const checks: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => checks.push([n, ok, d]);

async function main() {
  const lists = await importGearPdf(new Uint8Array(readFileSync(PDF)), PDF);
  const scene = buildScene(loadBuffer(readFileSync(PLAN), PLAN).document);
  const report = reconcile(lists[0], scene);

  check('produced rows', report.rows.length > 0, `${report.rows.length}`);
  check('ignored cable and consumables', report.ignored > 20, `${report.ignored}`);
  check('found items drawn but not listed', report.missingOnList > 0, `${report.missingOnList}`);
  check('problems sort above matches', report.rows[0].status !== 'match', report.rows[0].status);
  check('every row is consistent', report.rows.every((r) =>
    r.status === 'match' ? r.listed === r.drawn
    : r.status === 'missing-on-plan' ? r.drawn === 0
    : r.status === 'missing-on-list' ? r.listed === 0
    : r.listed !== r.drawn));

  console.log(`\nrows ${report.rows.length}  matched ${report.matched}  ` +
    `not drawn ${report.missingOnPlan}  not listed ${report.missingOnList}  ` +
    `count off ${report.countMismatch}  ignored ${report.ignored}\n`);
  for (const r of report.rows.slice(0, 8)) {
    console.log(`  ${r.status.padEnd(16)} listed ${String(r.listed).padStart(5)}  drawn ${String(r.drawn).padStart(5)}  ${r.name.slice(0, 44)}`);
  }

  let failed = 0;
  for (const [n, ok, d] of checks) { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${n}${!ok && d ? ` — ${d}` : ''}`); if (!ok) failed++; }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
void main();
