/**
 * Status-bar furniture counts and Insert catalog coverage.
 *
 *   npx tsx tools/room-viewer-parity-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countFurniture } from '../src/renderer/src/furniture-counts.js';
import {
  flattenInsertLeaves,
  insertCatalogCoverage,
  matchInsertItem,
  PALETTE_CATEGORIES,
} from '../src/inventory/insert-catalog.js';
import { Session } from '../src/main/session.js';
import {
  createRectangularRoom,
  openPlanModel,
  previewSeating,
  resetPlanModel,
} from '../src/main/plan-model.js';
import { companionPathFor } from '../src/main/companion-store.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { fixturePlanBuffer } from './test-fixture.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

const F = UNITS_PER_FOOT;

async function main(): Promise<void> {
  console.log('furniture counts\n');
  const counts = countFurniture([
    { name: 'Banquet Chair', count: 120 },
    { name: '60" Round Table', count: 15 },
    { name: 'Stage', count: 1 },
  ]);
  check('chairs tallied', counts.chairs === 120, String(counts.chairs));
  check('tables tallied', counts.tables === 15, String(counts.tables));
  const rental = countFurniture([
    { name: 'Chiavari Gold', count: 40 },
    { name: '72" Round', count: 5 },
  ]);
  check('chiavari counts as chairs', rental.chairs === 40, String(rental.chairs));
  check('round size counts as tables', rental.tables === 5, String(rental.tables));

  console.log('\ninsert catalog\n');
  const leaves = flattenInsertLeaves();
  check('has Fastfold and riser leaves', leaves.length >= 20, String(leaves.length));
  check('palette categories cover classic strip', PALETTE_CATEGORIES.length === 8);

  const seed = [
    { id: '1', name: "8' Fastfold Screen", category: 'screen' },
    { id: '2', name: 'Panasonic Projector', category: 'projector' },
    { id: '3', name: '4x8 Riser', category: 'riser' },
    { id: '4', name: 'Banquet Chair', category: 'chair' },
    { id: '5', name: '60" Round', category: 'table-round' },
    { id: '6', name: 'Speaker', category: 'speaker' },
    { id: '7', name: 'Tripod Screen', category: 'screen' },
    { id: '8', name: 'Truss 12ft', category: 'truss' },
  ];
  const ff = leaves.find((l) => l.id === 'ff-8');
  check('matches 8ft Fastfold', !!ff && matchInsertItem(ff, seed)?.id === '1');
  const coverage = insertCatalogCoverage(seed);
  check(
    'seed inventory covers a useful share of Insert leaves',
    coverage.matched >= 8,
    `${coverage.matched}/${coverage.total}`,
  );

  console.log('\nseating clearances IPC\n');
  const dir = mkdtempSync(join(tmpdir(), 'gp-parity-'));
  const planPath = join(dir, 'Parity.rv4');
  try {
    resetPlanModel();
    rmSync(companionPathFor(planPath), { force: true });
    writeFileSync(planPath, fixturePlanBuffer());
    const session = new Session(planPath, readFileSync(planPath));
    await openPlanModel(planPath, session.loaded.document, 'imperial');
    session.checkpoint();
    const room = createRectangularRoom(session, 40 * F, 30 * F, 'imperial');
    check('room drawn', room.ok, room.reason);
    session.refresh();

    const preview = previewSeating(session, {
      style: 'theatre',
      focusX: 20 * F,
      focusY: -6 * F,
      front: 8 * F,
      side: 5 * F,
      wing: 3 * F,
      rear: 4 * F,
      centreAisle: 6 * F,
      frontWall: 2 * F,
      aisle: 4 * F,
    });
    check('preview returns side clearance', preview.clearances.side === 5 * F, String(preview.clearances.side));
    check('preview returns wing clearance', preview.clearances.wing === 3 * F, String(preview.clearances.wing));
    check('preview returns rear clearance', preview.clearances.rear === 4 * F, String(preview.clearances.rear));
    check('preview returns centre aisle', preview.clearances.centreAisle === 6 * F);
    check('preview returns front wall', preview.clearances.frontWall === 2 * F);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

void main();
