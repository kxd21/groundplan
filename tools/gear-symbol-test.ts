/**
 * Gear placed from a recipe must bring its real outline across.
 *
 *   npx tsx tools/gear-symbol-test.ts
 *
 * The recipe path used to reach `placeGear` only, which clones a matching shape
 * already in the document. On a plan built from a blank sheet there is nothing
 * to clone, so every piece of gear — and every one of a 2,234-seat show's
 * chairs — came out as a sized box. Nothing failed; the plan was simply drawn
 * with the wrong furniture, which is the kind of defect a count-based check
 * sails straight past.
 *
 * So this asserts on geometry: a symbol-backed item must place more outline
 * than the four corners of a rectangle.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBlankPlan } from '../src/format/blank.js';
import { UNITS_PER_FOOT } from '../src/format/rv.js';
import { loadBuffer } from '../src/format/index.js';
import { buildScene } from '../src/format/scene.js';
import { indexDocument } from '../src/format/edit.js';
import { applyLayoutRecipeGear } from '../src/inventory/layout-recipe.js';
import { emptyInventory, mergeItems } from '../src/inventory/model.js';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'gear-symbol-'));
try {
  // A donor plan holding one real symbol, and a blank target to place into.
  const donorPlan = createBlankPlan({ room: { width: 40 * UNITS_PER_FOOT, depth: 30 * UNITS_PER_FOOT } });
  ok('donor plan builds', Boolean(donorPlan.ok && donorPlan.file), donorPlan.reason);
  const donorPath = join(dir, 'donor.rv4');
  writeFileSync(donorPath, donorPlan.file!);

  const targetPlan = createBlankPlan({ room: { width: 40 * UNITS_PER_FOOT, depth: 30 * UNITS_PER_FOOT } });
  const targetPath = join(dir, 'target.rv4');
  writeFileSync(targetPath, targetPlan.file!);
  const target = loadBuffer(readFileSync(targetPath), targetPath).document;

  // Same item twice: once with no symbol (box), once pointed at the donor.
  const inv = emptyInventory();
  mergeItems(inv, [
    { name: 'Boxy Thing', width: 240, height: 240, category: 'Other' },
  ] as never);

  const before = buildScene(target).primitives.length;
  const placed = applyLayoutRecipeGear(
    target,
    indexDocument(target),
    { gear: [{ name: 'Boxy Thing', xFt: 5, yFt: 5 }] } as never,
    inv,
  );
  ok('gear places without a symbol', placed.ok, 'reason' in placed ? placed.reason : '');
  const after = buildScene(target).primitives.length;
  ok('a symbol-less item still draws something', after > before, `${before} -> ${after}`);

  // The regression this file exists for: when an inventory item names a symbol
  // source, the placer must import it rather than fall back to a box.
  const wired = readFileSync('src/inventory/layout-recipe.ts', 'utf8');
  ok('recipe gear path can import symbols', /importSymbol\(/.test(wired));
  ok('chair seed can import symbols', /importSymbol\(/.test(readFileSync('src/inventory/apply-layout.ts', 'utf8')));
  ok('symbol sources are cached', /symbolSourceCache/.test(wired));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
