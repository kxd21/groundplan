/**
 * Spotlight inventory XML parser + merge into company inventory.
 *
 *   npx tsx tools/spotlight-xml-test.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyInventory, mergeItems, normaliseName } from '../src/inventory/model.js';
import { parseSpotlightInventoryXml } from '../src/inventory/spotlight-xml.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools/fixtures/spotlight-inventory-sample.xml');

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

function main() {
  const text = readFileSync(FIXTURE, 'utf8');
  const parsed = parseSpotlightInventoryXml(text);
  check('fixture parses', parsed.ok, parsed.ok ? undefined : parsed.reason);
  if (!parsed.ok) {
    report();
    process.exit(1);
  }

  check('inventory name', parsed.meta.name === 'Acme Warehouse', parsed.meta.name);
  check('vendor', parsed.meta.vendor === 'Acme Audio Visual', parsed.meta.vendor);
  check(
    'symbol rows present',
    parsed.items.some((i) => i.name === 'Source Four 26deg' && i.quantity === 48),
  );
  check(
    'category mapped to department',
    parsed.items.find((i) => i.name === 'Mac 600')?.department === 'Lighting',
  );
  check(
    'stock quantities',
    parsed.items.find((i) => i.name === 'FT34 Truss 2.5m')?.quantity === 40 &&
      parsed.items.find((i) => i.name === 'QSC K12.2')?.quantity === 8,
  );
  check(
    'associated virtual parts are catalogue rows',
    parsed.items.some((i) => i.name === 'Safety Cable' && i.virtual === true),
  );
  check(
    'associated VP default qty is not treated as stock',
    parsed.items.find((i) => i.name === 'Safety Cable')?.quantity === undefined,
  );
  check(
    'independent virtual parts keep stock',
    parsed.items.some((i) => i.name === 'Gaffer Tape' && i.virtual && i.quantity === 24),
  );

  const names = parsed.items.map((i) => normaliseName(i.name));
  check('no duplicate names in parse', names.length === new Set(names).size, String(names.length));

  const inventory = emptyInventory();
  const first = mergeItems(inventory, parsed.items, new Date(), {
    type: 'spotlight-xml',
    sourcePath: FIXTURE,
    label: parsed.meta.name,
  });
  check('merge adds all rows', first.added === parsed.items.length, `${first.added}`);
  const s4 = inventory.items.find((i) => i.name === 'Source Four 26deg');
  check('quantityOwned from Stock', s4?.quantityOwned === 48, String(s4?.quantityOwned));
  check('peakQuantity also set', s4?.peakQuantity === 48);
  check(
    'provenance type spotlight-xml',
    inventory.imports.some((entry) => entry.type === 'spotlight-xml' && entry.label === 'Acme Warehouse'),
  );

  const before = inventory.items.length;
  const second = mergeItems(inventory, parsed.items, new Date(), {
    type: 'spotlight-xml',
    sourcePath: FIXTURE,
    label: parsed.meta.name,
  });
  check('re-import adds nothing', second.added === 0 && inventory.items.length === before);
  check('re-import does not inflate owned', s4?.quantityOwned === 48);

  // Raise stock on re-import when the file says more.
  const raised = mergeItems(
    inventory,
    [{ name: 'Source Four 26deg', quantity: 60 }],
    new Date(),
    { type: 'spotlight-xml', sourcePath: FIXTURE + ':raised', label: 'raised' },
  );
  check('higher stock raises quantityOwned', raised.updated >= 1 && s4?.quantityOwned === 60);

  const bad = parseSpotlightInventoryXml('<NotInventory><Item><Name>x</Name></Item></NotInventory>');
  check('rejects non-inventory root', !bad.ok);

  const empty = parseSpotlightInventoryXml('<Inventory><InventoryInfo><Name>Empty</Name></InventoryInfo></Inventory>');
  check('rejects empty inventory', !empty.ok);

  report();
  const failed = checks.filter(([, ok]) => !ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

function report() {
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`${checks.length - failed}/${checks.length} spotlight-xml checks passed`);
}

main();
