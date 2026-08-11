/**
 * Stress coverage for Spotlight inventory XML → Groundplan merge.
 *
 * Large catalogues, repeated re-imports, alternate tag shapes, noisy XML,
 * quantityOwned raise/no-duplicate, and v3 save/reload.
 *
 *   npx tsx tools/spotlight-xml-stress-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

import { emptyInventory, mergeItems, normaliseName, updateInventoryItem } from '../src/inventory/model.js';
import { parseSpotlightInventoryXml } from '../src/inventory/spotlight-xml.js';
import { loadInventory, saveInventory } from '../src/inventory/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools/fixtures/spotlight-inventory-sample.xml');

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  pass  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildLargeXml(count: number, opts?: { vendor?: string; stockBase?: number }): string {
  const stockBase = opts?.stockBase ?? 1;
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    const dept = ['Lighting', 'Audio', 'Rigging', 'Video', 'Staging'][i % 5];
    const stock = stockBase + (i % 97);
    rows.push(`    <SymbolObject>
      <Name>Stress Fixture ${i}</Name>
      <Category>${dept}</Category>
      <PartType>Symbol</PartType>
      <Stock>${stock}</Stock>
      ${
        i % 11 === 0
          ? `<VirtualParts><VirtualPart><Name>VP for ${i}</Name><DefaultQuantity>2</DefaultQuantity></VirtualPart></VirtualParts>`
          : ''
      }
    </SymbolObject>`);
  }
  const ivps: string[] = [];
  for (let i = 0; i < Math.min(50, Math.floor(count / 40)); i++) {
    ivps.push(`    <IndependentVirtualPart>
      <Name>IVP Spare ${i}</Name>
      <PartType>IVP</PartType>
      <Stock>${10 + i}</Stock>
    </IndependentVirtualPart>`);
  }
  return `<?xml version="1.0"?>
<!-- stress inventory: ${count} symbols -->
<Inventory version="1">
  <InventoryInfo>
    <Name>Stress Warehouse ${count}</Name>
    <Vendor>${opts?.vendor ?? 'Stress Vendor'}</Vendor>
    <Notes>Generated stress fixture</Notes>
  </InventoryInfo>
  <Categories>
    <Category Name="Lighting"/><Category Name="Audio"/><Category Name="Rigging"/>
    <Category Name="Video"/><Category Name="Staging"/>
  </Categories>
  <SymbolObjects>
${rows.join('\n')}
  </SymbolObjects>
  <IndependentVirtualParts>
${ivps.join('\n')}
  </IndependentVirtualParts>
  <UnknownFutureStuff ignore="true"><Nested/></UnknownFutureStuff>
</Inventory>
`;
}

async function main(): Promise<void> {
  console.log('Spotlight XML inventory stress\n');

  // --- fixture baseline ----------------------------------------------------
  const fixture = parseSpotlightInventoryXml(readFileSync(FIXTURE, 'utf8'));
  check('sample fixture parses', fixture.ok);
  if (!fixture.ok) {
    process.exit(1);
  }
  check('sample has meta name', fixture.meta.name === 'Acme Warehouse');

  // --- alternate roots / tags ----------------------------------------------
  const altRoot = parseSpotlightInventoryXml(`<?xml version="1.0"?>
    <VWInventory>
      <Info><Name>Alt Root</Name><Vendor>VW</Vendor></Info>
      <Items>
        <Item><Name>Alt Leko</Name><Department>Lighting</Department><Quantity>7</Quantity></Item>
        <Symbol><Name>Alt Mac</Name><Category>Lighting</Category><StockQuantity>3</StockQuantity></Symbol>
      </Items>
      <IVPs>
        <IVP name="Alt Tape" stock="9" parttype="IVP"/>
      </IVPs>
    </VWInventory>`);
  check('VWInventory + Items/Item/Symbol/IVP shapes parse', altRoot.ok, altRoot.ok ? String(altRoot.items.length) : altRoot.reason);
  if (altRoot.ok) {
    check(
      'alternate quantity tags map',
      altRoot.items.some((i) => i.name === 'Alt Leko' && i.quantity === 7) &&
        altRoot.items.some((i) => i.name === 'Alt Mac' && i.quantity === 3),
    );
    check(
      'self-closing IVP attrs',
      altRoot.items.some((i) => i.name === 'Alt Tape' && i.quantity === 9 && i.virtual),
    );
  }

  // --- noise / CDATA / BOM -------------------------------------------------
  const noisy = parseSpotlightInventoryXml(
    `\uFEFF<?xml version="1.0"?><!-- bom + cdata -->
    <SpotlightInventory>
      <InventoryInfo><Name><![CDATA[CDATA Shop]]></Name></InventoryInfo>
      <SymbolObjects>
        <SymbolObject>
          <Name><![CDATA[Source Four & Co.]]></Name>
          <Category>Lighting</Category>
          <Stock>12</Stock>
        </SymbolObject>
      </SymbolObjects>
    </SpotlightInventory>`,
  );
  check('BOM + CDATA inventory parses', noisy.ok);
  if (noisy.ok) {
    check('CDATA name preserved', noisy.meta.name === 'CDATA Shop' && noisy.items[0]?.name === 'Source Four & Co.');
  }

  // --- large catalogue parse + merge ---------------------------------------
  const LARGE = 2500;
  const xml = buildLargeXml(LARGE);
  const t0 = performance.now();
  const large = parseSpotlightInventoryXml(xml);
  const parseMs = performance.now() - t0;
  check('2500-symbol inventory parses', large.ok, large.ok ? `${Math.round(parseMs)}ms` : large.reason);
  if (!large.ok) {
    process.exit(1);
  }
  check('parse under 2s', parseMs < 2000, `${Math.round(parseMs)}ms`);
  // symbols + associated VPs (~every 11th) + IVPs
  const expectedMin = LARGE; // at least one row per symbol
  check('large parse yields >= symbol count', large.items.length >= expectedMin, String(large.items.length));
  check(
    'associated VPs do not invent stock',
    large.items.filter((i) => i.virtual && /^VP for /.test(i.name)).every((i) => i.quantity === undefined),
  );

  const inventory = emptyInventory();
  const t1 = performance.now();
  const first = mergeItems(inventory, large.items, new Date(), {
    type: 'spotlight-xml',
    sourcePath: '/tmp/stress-warehouse.xml',
    label: large.meta.name,
  });
  const mergeMs = performance.now() - t1;
  check('first merge adds all unique names', first.added === large.items.length, `${first.added}`);
  check('merge under 1s', mergeMs < 1000, `${Math.round(mergeMs)}ms`);
  check(
    'quantityOwned set from Stock',
    inventory.items.find((i) => i.name === 'Stress Fixture 0')?.quantityOwned === 1,
  );
  check(
    'import ledger records spotlight-xml',
    inventory.imports.some((e) => e.type === 'spotlight-xml' && e.label === large.meta.name),
  );

  // --- re-import ×10 must not duplicate ------------------------------------
  const before = inventory.items.length;
  let reAdded = 0;
  const t2 = performance.now();
  for (let n = 0; n < 10; n++) {
    const again = mergeItems(inventory, large.items, new Date(), {
      type: 'spotlight-xml',
      sourcePath: '/tmp/stress-warehouse.xml',
      label: large.meta.name,
    });
    reAdded += again.added;
  }
  const reMs = performance.now() - t2;
  check('10× re-import adds zero rows', reAdded === 0 && inventory.items.length === before);
  check('10× re-import under 3s', reMs < 3000, `${Math.round(reMs)}ms`);

  // --- stock raise across a second file ------------------------------------
  const raisedXml = buildLargeXml(LARGE, { stockBase: 100, vendor: 'Raised' });
  const raised = parseSpotlightInventoryXml(raisedXml);
  check('raised-stock file parses', raised.ok);
  if (raised.ok) {
    const bump = mergeItems(inventory, raised.items, new Date(), {
      type: 'spotlight-xml',
      sourcePath: '/tmp/stress-warehouse-raised.xml',
      label: 'raised',
    });
    check('raised stock updates rows', bump.added === 0 && bump.updated > 0, `updated=${bump.updated}`);
    const f0 = inventory.items.find((i) => i.name === 'Stress Fixture 0');
    check('quantityOwned raised not lowered', f0?.quantityOwned === 100, String(f0?.quantityOwned));
    check('peakQuantity also raised', (f0?.peakQuantity ?? 0) >= 100);
  }

  // --- name-normalization dedupe inside one file ---------------------------
  const dupeFile = parseSpotlightInventoryXml(`<Inventory>
    <SymbolObjects>
      <SymbolObject><Name>Mac 600</Name><Category>Lighting</Category><Stock>5</Stock></SymbolObject>
      <SymbolObject><Name>  MAC   600 </Name><Category>Lighting</Category><Stock>9</Stock></SymbolObject>
      <SymbolObject><Name>mac 600</Name><Category>Lighting</Category><Stock>1</Stock></SymbolObject>
    </SymbolObjects>
  </Inventory>`);
  check('intra-file name normalize collapses dupes', dupeFile.ok && dupeFile.items.length === 1);
  if (dupeFile.ok) {
    check('first stock wins intra-file', dupeFile.items[0].quantity === 5);
  }

  // --- editor Owned patch + persistence ------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'groundplan-spotlight-stress-'));
  try {
    const path = join(dir, 'inventory.json');
    const sample = emptyInventory();
    mergeItems(sample, fixture.items, new Date(), {
      type: 'spotlight-xml',
      sourcePath: FIXTURE,
      label: fixture.meta.name,
    });
    const s4 = sample.items.find((i) => i.name === 'Source Four 26deg');
    check('fixture merge has Source Four', !!s4);
    if (s4) {
      const patched = updateInventoryItem(sample, s4.id, { quantityOwned: 99 });
      check('Owned patch applies', patched.ok && patched.changed && s4.quantityOwned === 99);
      const cleared = updateInventoryItem(sample, s4.id, { quantityOwned: null });
      check('Owned clear applies', cleared.ok && cleared.changed && s4.quantityOwned === undefined);
      updateInventoryItem(sample, s4.id, { quantityOwned: 48 });
    }

    await saveInventory(path, sample);
    const reloaded = await loadInventory(path);
    check('reload is schema v3', reloaded.version === 3);
    check('reload preserves item count', reloaded.items.length === sample.items.length);
    check(
      'reload preserves quantityOwned',
      reloaded.items.find((i) => i.name === 'Source Four 26deg')?.quantityOwned === 48,
    );
    check(
      'reload preserves virtual flag',
      reloaded.items.some((i) => i.name === 'Gaffer Tape' && i.virtual === true),
    );

    // Merge large catalogue onto disk inventory and round-trip once more.
    if (large.ok) {
      mergeItems(reloaded, large.items.slice(0, 500), new Date(), {
        type: 'spotlight-xml',
        sourcePath: '/tmp/partial.xml',
        label: 'partial',
      });
      await saveInventory(path, reloaded);
      const again = await loadInventory(path);
      const keys = new Set(again.items.map((i) => normaliseName(i.name)));
      check('no duplicate names after save/reload', keys.size === again.items.length, String(again.items.length));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // --- reject garbage without throwing -------------------------------------
  writeFileSync(join(tmpdir(), 'groundplan-spotlight-junk.xml'), '<<<<not xml', 'utf8');
  const junk = parseSpotlightInventoryXml('<<<<not xml');
  check('malformed XML fails softly', !junk.ok);
  const empty = parseSpotlightInventoryXml('<Inventory/>');
  check('empty Inventory fails softly', !empty.ok);
  const wrong = parseSpotlightInventoryXml('<html><body>nope</body></html>');
  check('non-inventory root fails softly', !wrong.ok);

  console.log(`\n${failed === 0 ? 'All' : failed} Spotlight XML stress check(s) ${failed === 0 ? 'passed' : 'failed'}.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
