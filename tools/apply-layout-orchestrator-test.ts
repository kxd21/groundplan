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

    /*
     * A recipe naming gear the plan does not end up with must not throw the
     * layout away.
     *
     * It used to: `requireGearNames` was checked after everything was placed
     * and any miss returned a failure, which the caller rolls back — so a live
     * kit that landed 2,234 chairs, two stages and 127 pieces of gear was
     * discarded whole because one speaker was not named the way the schedule
     * names it. The check is a sanity check on the recipe. It reports; it does
     * not destroy.
     */
    const out2 = join(dir, 'card-party-missing-gear.rv4');
    const blank2 = createBlankPlan(recipeBlankPlanArgs(raw));
    writeFileSync(out2, blank2.file!);
    resetPlanModel();
    const s2 = new Session(out2, readFileSync(out2));
    await openPlanModel(out2, s2.loaded.document, 'imperial');
    s2.checkpoint();
    // The item exists in the catalogue — so the recipe still passes pre-flight
    // validation — but the recipe never places it, so it cannot be on the plan
    // afterwards. That is exactly the shape of the real failure: gear that
    // resolves but does not end up named on the drawing.
    const inv2 = emptyInventory();
    mergeItems(inv2, recipeCatalogueStub(raw));
    mergeItems(inv2, [{ name: 'Ghost Widget 9000', width: 120, height: 120 }]);
    const withGhost = {
      ...raw,
      expectations: {
        ...raw.expectations,
        requireGearNames: [...(raw.expectations.requireGearNames ?? []), 'Ghost Widget 9000'],
      },
    };
    const applied2 = applyFullLayoutRecipe(s2, withGhost, {
      inventory: inv2,
      replaceExistingSeating: true,
      forceRoom: true,
    });
    check('a missing required item does not fail the apply', applied2.ok, applied2.reason);
    check('and the chairs are still there', applied2.chairsPlaced === 2234, String(applied2.chairsPlaced));
    check(
      'and the miss is reported by name',
      (applied2.missingGear ?? []).includes('Ghost Widget 9000'),
      JSON.stringify(applied2.missingGear),
    );
    check(
      'in the status line the user sees',
      /Ghost Widget 9000/.test(applied2.status ?? ''),
      applied2.status,
    );
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
