/**
 * Stress-test: recreate the defining Card Party hall, seating fan, and
 * two-tier house-riser layout from scratch.
 *
 *   npx tsx tools/card-party-recreate-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../src/main/session.js';
import {
  addStage,
  applySeating,
  createRectangularRoom,
  openPlanModel,
  previewSeating,
  resetPlanModel,
} from '../src/main/plan-model.js';
import { placeGear } from '../src/format/place.js';
import { createLabel, createDimension } from '../src/format/annotate.js';
import { indexDocument, measureNode } from '../src/format/edit.js';
import { verifyWritable } from '../src/format/write.js';
import { walk } from '../src/format/rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import { solveStage, tieredStage } from '../src/format/stage.js';
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

const F = UNITS_PER_FOOT;
const IN = UNITS_PER_INCH;

async function main(): Promise<void> {
  console.log('Card Party recreate — from-scratch stress test\n');

  {
    const build = tieredStage(
      0,
      0,
      42 * F,
      { depth: 8 * F, height: 32 * IN },
      { depth: 8 * F, height: 24 * IN },
      ['left', 'right'],
    );
    const solved = solveStage(build);
    check('tiered build has two levels', build.levels.length === 2);
    check('front is 32in', build.levels[0]!.height === 32 * IN);
    check('back is 24in', build.levels[1]!.height === 24 * IN);
    check('stairs on both sides', build.stairs.length === 2);
    const frontDecks = solved.decks.filter((d) => d.level === 0);
    check(
      '42×8 front tiles as seven 6×8 decks',
      frontDecks.length === 7 && frontDecks.every((d) => d.size === "6' x 8'"),
      frontDecks.map((d) => d.size).join(', ') || `${frontDecks.length} decks`,
    );
    check('no tiling shortfall notes', solved.notes.length === 0, solved.notes.join(' '));
  }

  const dir = mkdtempSync(join(tmpdir(), 'groundplan-card-party-'));
  const planPath = join(dir, 'Card Party recreate.rv4');

  try {
    resetPlanModel();
    writeFileSync(planPath, fixturePlanBuffer({ walls: false }));
    const session = new Session(planPath, readFileSync(planPath));
    await openPlanModel(planPath, session.loaded.document, 'imperial');

    const commit = (run: () => { ok: boolean; reason?: string; created?: number[] }) => {
      session.checkpoint();
      const result = run();
      if (result.ok) session.refresh();
      else session.rollback();
      return result;
    };

    // The reference drawing is roughly 305' × 165' and contains 2,234 chairs.
    const room = commit(() => createRectangularRoom(session, 305 * F, 165 * F, 'imperial'));
    check('room created', room.ok, room.reason);

    const stageX = -21 * F;
    const stageY = -82.5 * F;
    const stage = commit(() =>
      addStage(session, stageX, stageY, 42 * F, 8 * F, 32 * IN, {
        back: { depth: 8 * F, height: 24 * IN },
        stairs: ['left', 'right'],
      }),
    );
    check('tiered stage placed', stage.ok, stage.reason);
    check('stage has geometry', (stage.created?.length ?? 0) > 0);

    const doc = session.loaded.document;
    let index = indexDocument(doc);

    // Seed a correctly sized chair once. The seating renderer then clones this
    // catalogue shape instead of falling back to a generic equipment box.
    const chairTemplate = placeGear(doc, index, 'Stacking Chair', -148 * F, 78 * F, {
      width: 20 * IN,
      height: 20 * IN,
    });
    check('chair type is available', chairTemplate.ok, chairTemplate.reason);
    index = indexDocument(doc);

    const seatingRequest = {
      style: 'theatre' as const,
      focusX: 0,
      focusY: -90 * F,
      splay: 30,
      sectionCentre: 28,
      sectionWing: 14,
      centreAisle: 6 * F,
      rowsPerBlock: 14,
      aisle: 5 * F,
      maxSeats: 2234,
    };
    const seatingPreview = previewSeating(session, seatingRequest);
    check('full Card Party seat count fits', seatingPreview.seats === 2234, `${seatingPreview.seats}`);
    const seating = commit(() => applySeating(session, seatingRequest, 'Stacking Chair'));
    check('2,234-seat fan placed', seating.ok, seating.reason);

    const lemgs: number[] = [];
    for (const x of [-20, -16, -12, 10, 14, 18].map((n) => n * F)) {
      const placed = placeGear(doc, index, "4' x 4' Riser", x, stageY + 4 * F);
      check(`LEMG at ${x / F}ft`, placed.ok, placed.reason);
      if (placed.created) lemgs.push(...placed.created);
      index = indexDocument(doc);
    }

    for (const [x, y] of [
      [-8 * F, stageY + 2 * F],
      [8 * F, stageY + 2 * F],
    ] as const) {
      const curved = placeGear(doc, index, "Curved Riser 4' x 4'", x, y);
      check('curved LEMG placed', curved.ok, curved.reason);
      index = indexDocument(doc);
    }

    const label = createLabel(
      doc,
      index,
      "2 Pieces of Carpet\n1 - 12' X 42'\n1 - 8' X 42'",
      0,
      -10 * F,
    );
    check('carpet label', label.ok, label.reason);
    index = indexDocument(doc);
    const rope = createLabel(doc, index, 'Edge Rope Lighting', 0, stageY + 4 * F);
    check('rope lighting label', rope.ok, rope.reason);
    index = indexDocument(doc);
    const dim = createDimension(doc, index, stageX, stageY + 16 * F, stageX + 42 * F, stageY + 16 * F);
    check('42ft dimension', dim.ok, dim.reason);

    session.refresh();

    const names: string[] = [];
    for (const n of walk(doc)) {
      if (n.cls === 'RVShape' && n.labels[0]) names.push(n.labels[0]);
    }
    check(
      'tiered stage shape on plan',
      names.some((n) => /tiered|stage/i.test(n)),
      names.slice(0, 8).join(' | '),
    );
    check('LEMG boxes on plan', lemgs.length >= 6, `${lemgs.length}`);

    let stackingChairs = 0;
    let angledChairs = 0;
    for (const n of walk(doc)) {
      if (n.cls !== 'RVShape' || n.labels[0] !== 'Stacking Chair') continue;
      stackingChairs++;
      const degrees = Math.round((((n.angle ?? 0) * 180) / Math.PI + 360) % 360);
      if (degrees % 90 !== 0) angledChairs++;
    }
    check('high-density chair inventory survives', stackingChairs >= 2234, `${stackingChairs}`);
    check('side seating banks are angled', angledChairs > 100, `${angledChairs}`);

    let stageWidth = 0;
    for (const n of walk(doc)) {
      if (n.cls !== 'RVShape') continue;
      const label = n.labels[0] ?? '';
      // Stairs are named "Stairs · Tiered stage …" — measure the stage only.
      if (/^stairs\b/i.test(label)) continue;
      if (!/^(tiered\s+)?stage\b/i.test(label)) continue;
      const m = measureNode(n);
      stageWidth = Math.max(stageWidth, m.width);
    }
    check(
      'stage footprint ~42×16ft',
      Math.abs(stageWidth - 42 * F) < F,
      `${(stageWidth / F).toFixed(1)}ft`,
    );

    const writable = verifyWritable(doc);
    check('plan is writable', writable.ok, 'reason' in writable ? String(writable.reason) : undefined);

    console.log(`\nRecreated objects (sample names): ${names.slice(0, 12).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
