/**
 * Seating bank grouping must link furniture roots only — not clone-subtree
 * children — so banquet banks stay ~11 members (1 table + 10 chairs).
 *
 *   npx tsx tools/seating-group-roots-test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBlankPlan } from '../src/format/blank.js';
import { indexDocument } from '../src/format/edit.js';
import { addSeating } from '../src/format/seating.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
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
const BANQUET = join(ROOT, 'tools/fixtures/banquet-120-layout-recipe.json');

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

/** Same rule as main `rootIdsAmong`: drop ids whose parent is also in the batch. */
function rootIdsAmong(
  ids: number[],
  index: ReturnType<typeof indexDocument>,
): number[] {
  const candidates = ids.filter((id) => index.byId.has(id));
  const inBatch = new Set(candidates);
  return candidates.filter((id) => {
    const node = index.byId.get(id);
    if (!node) return false;
    const parent = index.parentOf.get(node);
    return !parent || !inBatch.has(parent.id);
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gp-seat-roots-'));
  const out = join(dir, 'ballroom.rv4');
  try {
    const blank = createBlankPlan({
      room: { width: 60 * UNITS_PER_FOOT, depth: 40 * UNITS_PER_FOOT },
    });
    if (!blank.ok || !blank.file) throw new Error(blank.reason ?? 'blank failed');
    writeFileSync(out, blank.file);
    resetPlanModel();
    const session = new Session(out, readFileSync(out));
    await openPlanModel(out, session.loaded.document, 'imperial');
    const doc = session.loaded.document;

    let index = indexDocument(doc);
    const first = addSeating(doc, index, {
      kind: 'round',
      x: 0,
      y: 0,
      chair: 'Chair',
      table: 'Round 60"',
      seats: 10,
    });
    check('first bank places 11', first.ok === true && first.placed === 11, String(first.placed));
    check(
      'first bank created is larger than placed (subtree ids)',
      (first.created?.length ?? 0) > 11,
      String(first.created?.length),
    );
    index = indexDocument(doc);
    check(
      'first bank roots == placed',
      rootIdsAmong(first.created ?? [], index).length === 11,
      String(rootIdsAmong(first.created ?? [], index).length),
    );

    const second = addSeating(doc, index, {
      kind: 'round',
      x: 1200,
      y: 0,
      chair: 'Chair',
      table: 'Round 60"',
      seats: 10,
    });
    check('second bank places 11', second.ok === true && second.placed === 11, String(second.placed));
    check(
      'second bank created ≈ 33 (3 nodes × 11 pieces)',
      (second.created?.length ?? 0) === 33,
      String(second.created?.length),
    );
    index = indexDocument(doc);
    check(
      'second bank roots == placed',
      rootIdsAmong(second.created ?? [], index).length === 11,
      String(rootIdsAmong(second.created ?? [], index).length),
    );

    // Full banquet-120 recipe: each seating block's created collapses to 11 roots.
    const raw = JSON.parse(readFileSync(BANQUET, 'utf8'));
    check('banquet fixture', isLayoutRecipe(raw));
    const inv = emptyInventory();
    mergeItems(inv, recipeCatalogueStub(raw));
    check('banquet validates', validateLayoutRecipe(raw, inv).ok);

    const banquetPath = join(dir, 'banquet.rv4');
    writeFileSync(banquetPath, blank.file);
    resetPlanModel();
    const banquetSession = new Session(banquetPath, readFileSync(banquetPath));
    await openPlanModel(banquetPath, banquetSession.loaded.document, 'imperial');
    banquetSession.checkpoint();
    const applied = applyFullLayoutRecipe(banquetSession, raw, {
      inventory: inv,
      replaceExistingSeating: true,
    });
    check('banquet apply', applied.ok === true && applied.chairsPlaced === 120, applied.reason);
    const seating = applied.seating ?? [];
    check('banquet 12 blocks', seating.length === 12, String(seating.length));
    const live = indexDocument(banquetSession.loaded.document);
    let allRootsOk = true;
    const rootSizes: number[] = [];
    for (const block of seating) {
      if (!block.ok || !block.created) {
        allRootsOk = false;
        continue;
      }
      const roots = rootIdsAmong(block.created, live);
      rootSizes.push(roots.length);
      if (roots.length !== 11) allRootsOk = false;
    }
    check('each banquet block roots to 11', allRootsOk, rootSizes.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (ok) console.log(`  ok  ${name}`);
    else {
      failed++;
      console.log(` FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
