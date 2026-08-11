/**
 * Exercises the equipment inventory: importing a real gear list, deduping across
 * jobs, remembering hand-set sizes, and round-tripping to disk.
 *
 *   npx tsx tools/inventory-test.ts
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importGearPdf } from '../src/gear/import-pdf.js';
import { walkItems } from '../src/gear/model.js';
import { parseDimensions } from '../src/format/place.js';
import { emptyInventory, mergeItems, searchInventory, departmentsOf, parseCsv } from '../src/inventory/model.js';
import { loadInventory, saveInventory } from '../src/inventory/store.js';

const PDF = process.argv[2] ?? '/Users/princedavidthompson/Downloads/Spring Gala 2026 - Example City.pdf';
const UNITS_PER_FOOT = 120;

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

async function main() {
  const inventory = emptyInventory();
  const lists = await importGearPdf(new Uint8Array(readFileSync(PDF)), PDF);

  /** Folds one job's lists in, exactly as the app's importer does. */
  const absorb = () => {
    let added = 0;
    let updated = 0;
    for (const list of lists) {
      for (const department of list.departments) {
        const incoming = [];
        for (const item of walkItems({ ...list, departments: [department] })) {
          if (item.note) continue;
          const size = parseDimensions(item.description);
          incoming.push({
            name: item.description,
            department: department.name,
            quantity: item.quantity,
            width: size.source === 'parsed' ? size.width : undefined,
            height: size.source === 'parsed' ? size.height : undefined,
            sizeSource: size.source === 'parsed' ? ('parsed' as const) : ('unknown' as const),
          });
        }
        const summary = mergeItems(inventory, incoming, new Date(), {
          id: `test-job:${list.jobNumber ?? list.sourceFingerprint ?? list.id ?? list.title}`,
          type: 'gear-pdf',
          jobId: list.jobNumber,
          sourcePath: list.sourcePath,
          label: list.title,
        });
        added += summary.added;
        updated += summary.updated;
      }
    }
    return { added, updated };
  };

  const first = absorb();
  check('imports items from the gear list', first.added > 300, `${first.added} added`);
  check('inventory holds them', inventory.items.length === first.added);

  const departments = departmentsOf(inventory);
  check('groups by department', departments.length >= 10, `${departments.length} departments`);
  check(
    'Lighting is one of them',
    departments.some((d) => d.name === 'Lighting'),
    departments.map((d) => d.name).join(', '),
  );

  // Re-importing the same job must not duplicate anything.
  const before = inventory.items.length;
  const second = absorb();
  check('re-importing adds nothing new', second.added === 0, `${second.added} added again`);
  check('item count is unchanged', inventory.items.length === before, `${inventory.items.length} vs ${before}`);
  check(
    're-importing the same job does not inflate its sighting count',
    inventory.items[0].timesSeen === 1,
    String(inventory.items[0].timesSeen),
  );

  // A size parsed from the name should be there.
  const deck = inventory.items.find((i) => /Intellistage 4' x 4' Stage Deck/i.test(i.name));
  check('sized a stage deck from its name', !!deck?.width && Math.abs(deck.width - 4 * UNITS_PER_FOOT) < 1);

  // A hand-set size must survive a later import.
  const leko = inventory.items.find((i) => /Leko|Source Four/i.test(i.name)) ?? inventory.items[5];
  leko.width = 1 * UNITS_PER_FOOT;
  leko.height = 1.5 * UNITS_PER_FOOT;
  leko.sizeSource = 'user';
  absorb();
  check(
    'a hand-set size is never overwritten by a guess',
    leko.sizeSource === 'user' && leko.width === 1 * UNITS_PER_FOOT && leko.height === 1.5 * UNITS_PER_FOOT,
    `${leko.name}: ${leko.width}x${leko.height} (${leko.sizeSource})`,
  );

  // Search.
  const found = searchInventory(inventory, 'shure', null);
  check('searches by name', found.length > 5 && found.every((i) => /shure/i.test(i.name)), `${found.length} hits`);
  const lighting = searchInventory(inventory, '', 'Lighting');
  check('filters by department', lighting.length > 0 && lighting.every((i) => i.department === 'Lighting'));

  // CSV import.
  const csv = 'Name,Department,Quantity\nGenie Lift AWP-30,Rigging,2\n"Truss, 12in x 10ft",Rigging,8\n';
  const parsed = parseCsv(csv);
  check('parses CSV with quoted commas', parsed.length === 2 && parsed[1].name === 'Truss, 12in x 10ft');
  const csvSummary = mergeItems(inventory, parsed);
  check('merges CSV rows', csvSummary.added === 2);
  const genie = inventory.items.find((i) => i.name === 'Genie Lift AWP-30');
  check('CSV quantity sets quantityOwned', genie?.quantityOwned === 2, String(genie?.quantityOwned));

  // Persistence.
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-lib-'));
  const path = join(dir, 'inventory-inventory.json');
  await saveInventory(path, inventory);
  const reloaded = await loadInventory(path);
  check('saves and reloads', reloaded.items.length === inventory.items.length);
  const reloadedLeko = reloaded.items.find((i) => i.name === leko.name);
  check(
    'hand-set size survives a reload',
    reloadedLeko?.sizeSource === 'user' && reloadedLeko.width === 1 * UNITS_PER_FOOT,
  );

  // Ids must not depend on the array's length, which is reused after a removal,
  // and must survive re-importing the same list.
  const clashA = `Gray Valence Drape w/Grommets & Pocket - 15"H x 14'W (Dress Kit)`;
  const clashB = `Gray Valence Drape w/Grommets & Pocket - 15"H x 9'8"W (Dress Kit)`;
  const ids = emptyInventory();
  mergeItems(ids, [{ name: clashA }, { name: clashB }]);
  check('names sharing a truncated slug get different ids', ids.items[0].id !== ids.items[1].id);

  const removedId = ids.items.find((i) => i.name === clashA)?.id;
  const keptId = ids.items.find((i) => i.name === clashB)?.id;
  ids.items = ids.items.filter((i) => i.name !== clashA);
  mergeItems(ids, [{ name: clashA }]);
  check(
    'an id is not recycled after a removal',
    new Set(ids.items.map((i) => i.id)).size === ids.items.length &&
      ids.items.find((i) => i.name === clashA)?.id !== removedId,
  );

  mergeItems(ids, [{ name: clashB }]);
  check('re-importing the same item keeps its id', ids.items.find((i) => i.name === clashB)?.id === keptId);
  check('re-importing the same item does not duplicate it', ids.items.length === 2);

  const missing = await loadInventory(join(dir, 'does-not-exist.json'));
  check('a missing inventory starts empty rather than failing', missing.items.length === 0);

  rmSync(dir, { recursive: true, force: true });

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  console.log(`inventory: ${inventory.items.length} items across ${departmentsOf(inventory).length} departments`);
  process.exit(failed ? 1 : 0);
}

void main();
