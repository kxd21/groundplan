/**
 * Clear seating before replace — apply kit must not stack chairs.
 *
 *   npx tsx tools/layout-recipe-replace-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBlankPlan } from '../src/format/blank.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { buildSchedule } from '../src/format/schedule.js';
import { applyFullLayoutRecipe } from '../src/inventory/apply-layout.js';
import {
  isLayoutRecipe,
  recipeCatalogueStub,
  validateLayoutRecipe,
} from '../src/inventory/layout-recipe.js';
import { emptyInventory, mergeItems } from '../src/inventory/model.js';
import { Session } from '../src/main/session.js';
import { openPlanModel, resetPlanModel } from '../src/main/plan-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARDROOM = join(ROOT, 'tools/fixtures/boardroom-20-layout-recipe.json');

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(BOARDROOM, 'utf8'));
  check('fixture', isLayoutRecipe(raw));
  const inv = emptyInventory();
  mergeItems(inv, recipeCatalogueStub(raw));
  check('validates', validateLayoutRecipe(raw, inv).ok);

  const dir = mkdtempSync(join(tmpdir(), 'gp-replace-'));
  const out = join(dir, 'boardroom.rv4');
  try {
    const blank = createBlankPlan({
      room: { width: 20 * UNITS_PER_FOOT, depth: 16 * UNITS_PER_FOOT },
    });
    writeFileSync(out, blank.file!);
    resetPlanModel();
    const session = new Session(out, readFileSync(out));
    await openPlanModel(out, session.loaded.document, 'imperial');
    session.checkpoint();

    const first = applyFullLayoutRecipe(session, raw, { inventory: inv });
    check('first apply', first.ok && first.chairsPlaced === 18, first.reason ?? String(first.chairsPlaced));

    const stacked = applyFullLayoutRecipe(session, raw, {
      inventory: inv,
      replaceExistingSeating: true,
      replaceExistingGear: true,
    });
    check('replace apply', stacked.ok && stacked.chairsPlaced === 18, stacked.reason);
    const sched = buildSchedule(session.loaded.document);
    const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    check('no stacked chairs', chairs === 18, String(chairs));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
