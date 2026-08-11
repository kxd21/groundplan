/**
 * Apply a layout recipe to a brand-new blank plan (print-faithful rebuild path).
 *
 *   npx tsx tools/apply-layout-recipe.ts [recipe.json] [out.rv4]
 *
 * Uses applyFullLayoutRecipe — same path as IPC and MCP.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Session } from '../src/main/session.js';
import { openPlanModel, resetPlanModel } from '../src/main/plan-model.js';
import { verifyWritable } from '../src/format/write.js';
import { createBlankPlan } from '../src/format/blank.js';
import { buildSchedule } from '../src/format/schedule.js';
import {
  isLayoutRecipe,
  recipeCatalogueStub,
  validateLayoutRecipe,
} from '../src/inventory/layout-recipe.js';
import { applyFullLayoutRecipe, recipeBlankPlanArgs } from '../src/inventory/apply-layout.js';
import { emptyInventory, mergeItems } from '../src/inventory/model.js';

const RECIPE_PATH = resolve(
  process.argv[2] ?? join('tools', 'fixtures', 'card-party-layout-recipe.json'),
);
const OUT = resolve(
  process.argv[3] ??
    join(process.env.HOME ?? '.', 'Downloads', 'Card Party South Florida — recipe.rv4'),
);

function must(label: string, ok: boolean, detail?: string): void {
  if (!ok) throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ''}`);
}

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(RECIPE_PATH, 'utf8'));
  must('recipe format', isLayoutRecipe(raw));
  const recipe = raw;

  const inv = emptyInventory();
  mergeItems(inv, recipeCatalogueStub(recipe));
  const validated = validateLayoutRecipe(recipe, inv);
  must('recipe validates', validated.ok, validated.ok ? undefined : validated.reason);

  console.log(`Applying ${RECIPE_PATH}\n→ ${OUT}\n`);

  const blank = createBlankPlan(recipeBlankPlanArgs(recipe));
  must('blank plan', Boolean(blank.ok && blank.file), blank.reason);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, blank.file!);

  resetPlanModel();
  const session = new Session(OUT, readFileSync(OUT));
  await openPlanModel(OUT, session.loaded.document, 'imperial');

  session.checkpoint();
  const applied = applyFullLayoutRecipe(session, recipe, {
    inventory: inv,
    replaceExistingSeating: true,
    forceRoom: true,
  });
  if (!applied.ok) {
    session.rollback();
    throw new Error(applied.reason);
  }
  session.refresh();
  must('full apply', applied.ok, applied.status);

  const writable = verifyWritable(session.loaded.document);
  must('writable', writable.ok);

  writeFileSync(OUT, session.file());
  const sched = buildSchedule(session.loaded.document);
  const chairs = sched.groups.filter((g) => /chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
  const nonChair = sched.groups.filter((g) => !/chair/i.test(g.name)).reduce((a, g) => a + g.count, 0);
  console.log(`\nWrote ${OUT}`);
  console.log(`Schedule chairs: ${chairs} (expect ${recipe.expectations.chairs})`);
  console.log(`Schedule non-chair: ${nonChair}`);
  must('chair expectation', chairs === recipe.expectations.chairs);

  const audit = join('docs', 'audit', 'Card Party South Florida — recipe.rv4');
  mkdirSync(dirname(audit), { recursive: true });
  copyFileSync(OUT, audit);
  console.log(`Also copied to ${audit}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
