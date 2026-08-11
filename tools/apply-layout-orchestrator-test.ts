/**
 * Full layout apply orchestrator — Card Party kit must land 2234 chairs.
 *
 *   npx tsx tools/apply-layout-orchestrator-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from '../src/main/session.js';
import { openPlanModel, resetPlanModel } from '../src/main/plan-model.js';
import { createBlankPlan } from '../src/format/blank.js';
import { buildSchedule } from '../src/format/schedule.js';
import {
  isLayoutRecipe,
  recipeCatalogueStub,
  validateLayoutRecipe,
} from '../src/inventory/layout-recipe.js';
import { applyFullLayoutRecipe, recipeBlankPlanArgs } from '../src/inventory/apply-layout.js';
import { emptyInventory, mergeItems } from '../src/inventory/model.js';
import { listLayoutKits, loadLayoutKit } from '../src/inventory/layout-kits.js';
import { exportLayoutRecipe } from '../src/inventory/export-layout-recipe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPE_PATH = join(ROOT, 'tools/fixtures/card-party-layout-recipe.json');

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(RECIPE_PATH, 'utf8'));
  check('fixture is recipe', isLayoutRecipe(raw));

  const kits = listLayoutKits(join(ROOT, 'tmp-nonexistent-user-data'));
  check('bundled kit listed', kits.some((k) => k.id === 'bundled:card-party'), String(kits.length));
  const bundled = loadLayoutKit(join(ROOT, 'tmp-nonexistent-user-data'), 'bundled:card-party');
  check('bundled kit loads', Boolean(bundled && isLayoutRecipe(bundled)));

  const inv = emptyInventory();
  mergeItems(inv, recipeCatalogueStub(raw));
  const validated = validateLayoutRecipe(raw, inv);
  check('recipe validates', validated.ok, validated.ok ? undefined : validated.reason);

  const dir = mkdtempSync(join(tmpdir(), 'gp-layout-'));
  const out = join(dir, 'card-party.rv4');
  try {
    const blank = createBlankPlan(recipeBlankPlanArgs(raw));
    check('blank ok', Boolean(blank.ok && blank.file), blank.reason);
    writeFileSync(out, blank.file!);

    resetPlanModel();
    const session = new Session(out, readFileSync(out));
    await openPlanModel(out, session.loaded.document, 'imperial');
    session.checkpoint();
    const applied = applyFullLayoutRecipe(session, raw, {
      inventory: inv,
      replaceExistingSeating: true,
      forceRoom: true,
    });
    check('apply ok', applied.ok, applied.reason ?? applied.status);
    check('chairs placed 2234', applied.chairsPlaced === 2234, String(applied.chairsPlaced));
    check('stages placed', applied.stagesPlaced === 2, String(applied.stagesPlaced));
    check('gear placed', applied.gearPlaced === 127, String(applied.gearPlaced));

    writeFileSync(out, session.file());
    const sched = buildSchedule(session.loaded.document);
    const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
    check('schedule chairs 2234', chairs === 2234, String(chairs));

    const exported = exportLayoutRecipe(session.loaded.document);
    check('export is recipe', isLayoutRecipe(exported));
    check('export chair total > 0', exported.expectations.chairs > 0, String(exported.expectations.chairs));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
