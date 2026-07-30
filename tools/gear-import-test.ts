/**
 * Checks a gear-list import against the printed page.
 *
 *   npx tsx tools/gear-import-test.ts "<gear list>.pdf" [--dump]
 */

import { readFileSync } from 'node:fs';

import { importGearPdf } from '../src/gear/import-pdf.js';
import { totalsFor, departmentTotals, type GearItem } from '../src/gear/model.js';

const path = process.argv[2] ?? '/Users/princedavidthompson/Downloads/Card Party 2026 - Dallas TX.pdf';
const dump = process.argv.includes('--dump');

async function main() {
  const lists = await importGearPdf(new Uint8Array(readFileSync(path)), path);
  console.log(`lists found: ${lists.length}\n`);

  for (const list of lists) {
    console.log(`${list.title}`);
    console.log(`  job         ${list.jobNumber ?? '—'}`);
    console.log(`  location    ${list.location ?? '—'}`);
    console.log(`  departments ${list.departments.length}`);

    for (const d of list.departments) {
      const t = departmentTotals(d);
      const top = d.items.filter((i) => !i.note).length;
      const packages = d.items.filter((i) => i.children.length).length;
      console.log(
        `    ${d.name.padEnd(26)} ${String(top).padStart(4)} lines  ${String(packages).padStart(3)} packages  ${String(t.pieces).padStart(6)} pieces`,
      );
    }

    const totals = totalsFor(list);
    console.log(
      `  totals: ${totals.lines} top-level, ${totals.allLines} incl. contents, ${totals.pieces} pieces, ${totals.notes} notes\n`,
    );

    if (dump) {
      const show = (items: GearItem[], indent: string) => {
        for (const item of items) {
          console.log(`${indent}${item.note ? '   · ' : String(item.quantity).padStart(4) + ' '}${item.description}`);
          show(item.children, indent + '    ');
        }
      };
      for (const d of list.departments) {
        console.log(`  == ${d.name}`);
        show(d.items, '    ');
      }
    }
  }
}

void main();
