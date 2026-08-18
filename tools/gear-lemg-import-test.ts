/**
 * LEMG / Omni PULL SHEET import regression.
 *
 *   npx tsx tools/gear-lemg-import-test.ts [path-to-pull.pdf]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { importGearPdf } from '../src/gear/import-pdf.js';
import { totalsFor } from '../src/gear/model.js';

const defaultPull = join(
  process.env.HOME || '',
  'Downloads',
  '20260816-19_Electricities_Annual Conference PULL.pdf',
);
const path = process.argv[2] || defaultPull;

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(` FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

async function main() {
  if (!existsSync(path)) {
    console.log(`skip: no pull PDF at ${path}`);
    process.exit(0);
  }
  console.log(`LEMG pull import · ${path}`);
  const lists = await importGearPdf(new Uint8Array(readFileSync(path)), path);
  check('one list', lists.length === 1, `got ${lists.length}`);
  const list = lists[0]!;
  check('title from job line', /Electricities/i.test(list.title), list.title);
  check('job number', list.jobNumber === '2508', String(list.jobNumber));
  check('location', /Omni Homestead/i.test(list.location ?? ''), list.location);
  const names = list.departments.map((d) => d.name);
  for (const want of ['Audio', 'Video', 'Lighting', 'Power', 'Scenic', 'Miscellaneous']) {
    check(`dept ${want}`, names.includes(want), names.join(', '));
  }
  const totals = totalsFor(list);
  check('has top-level lines', totals.lines >= 50, String(totals.lines));
  check('has package contents', totals.allLines > totals.lines, String(totals.allLines));
  check('piece count', totals.pieces >= 500, String(totals.pieces));
  const audio = list.departments.find((d) => d.name === 'Audio');
  const wireless = audio?.items.find((i) => /ULXD 8 Pack/i.test(i.description));
  check('Audio ULXD package', Boolean(wireless), wireless?.description);
  check('ULXD has children', (wireless?.children.length ?? 0) >= 5, String(wireless?.children.length));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
