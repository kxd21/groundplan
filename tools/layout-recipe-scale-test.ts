/**
 * scaleLayoutRecipeToRoom — positions stretch with the target room.
 *
 *   npx tsx tools/layout-recipe-scale-test.ts
 */
import { emptyInventory, mergeItems } from '../src/inventory/model.js';
import { buildSchedule } from '../src/format/schedule.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
import {
  isLayoutRecipe,
  layoutRecipeFitsRoom,
  scaleLayoutRecipeToRoom,
  recipeCatalogueStub,
  validateLayoutRecipe,
} from '../src/inventory/layout-recipe.js';
import { applyFullLayoutRecipe, recipeBlankPlanArgs } from '../src/inventory/apply-layout.js';
import { createBlankPlan } from '../src/format/blank.js';
import { Session } from '../src/main/session.js';
import { openPlanModel, resetPlanModel } from '../src/main/plan-model.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARDROOM = join(ROOT, 'tools/fixtures/boardroom-20-layout-recipe.json');

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(BOARDROOM, 'utf8'));
  check('fixture is recipe', isLayoutRecipe(raw));
  check('fits 20×16', layoutRecipeFitsRoom(raw, 20, 16));
  check('does not fit 30×20', !layoutRecipeFitsRoom(raw, 30, 20));

  const scaled = scaleLayoutRecipeToRoom(raw, 40, 32);
  check('scaled room 40×32', scaled.room?.widthFt === 40 && scaled.room?.depthFt === 32);
  check(
    'seating y doubled',
    Math.abs((scaled.seating[0]?.yFt ?? 0) - (raw.seating[0].yFt * 2)) < 1e-9,
    String(scaled.seating[0]?.yFt),
  );
  check(
    'seat count unchanged',
    scaled.seating[0]?.expectCount === raw.seating[0].expectCount,
  );
  check(
    'spacing scaled',
    Math.abs((scaled.seating[0]?.seatSpacingFt ?? 0) - (raw.seating[0].seatSpacingFt * 2)) < 1e-9,
  );

  const inv = emptyInventory();
  mergeItems(inv, recipeCatalogueStub(raw));
  check('validates', validateLayoutRecipe(scaled, inv).ok);

  const dir = mkdtempSync(join(tmpdir(), 'gp-scale-'));
  const out = join(dir, 'meeting.rv4');
  try {
    const blank = createBlankPlan({
      room: { width: 30 * UNITS_PER_FOOT, depth: 20 * UNITS_PER_FOOT },
    });
    check('blank 30×20', Boolean(blank.ok && blank.file), blank.reason);
    writeFileSync(out, blank.file!);
    resetPlanModel();
    const session = new Session(out, readFileSync(out));
    await openPlanModel(out, session.loaded.document, 'imperial');
    // Ensure room exists for fit path (blank already has walls).
    session.checkpoint();
    const applied = applyFullLayoutRecipe(session, raw, {
      inventory: inv,
      fitToExistingRoom: true,
      createRoomIfMissing: false,
    });
    check('apply fitted ok', applied.ok, applied.reason ?? applied.status);
    check('fitted status', /fitted to room/i.test(applied.status ?? ''), applied.status);
    check('chairs 18', applied.chairsPlaced === 18, String(applied.chairsPlaced));
    const sched = buildSchedule(session.loaded.document);
    const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    check('schedule chairs 18', chairs === 18, String(chairs));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Force-room path must keep authored size (no fit).
  const dir2 = mkdtempSync(join(tmpdir(), 'gp-force-'));
  const out2 = join(dir2, 'exact.rv4');
  try {
    const blank = createBlankPlan(recipeBlankPlanArgs(raw));
    writeFileSync(out2, blank.file!);
    resetPlanModel();
    const session = new Session(out2, readFileSync(out2));
    await openPlanModel(out2, session.loaded.document, 'imperial');
    session.checkpoint();
    const applied = applyFullLayoutRecipe(session, raw, {
      inventory: inv,
      forceRoom: true,
      replaceExistingSeating: true,
    });
    check('forceRoom apply ok', applied.ok, applied.reason);
    check('forceRoom not fitted', !/fitted to room/i.test(applied.status ?? ''), applied.status);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
  }
  console.log(`\n${checks.length} checks passed`);
}

void main();
