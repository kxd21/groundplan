/**
 * Stress every major feature from the Card Party / inventory / Item / stage arc.
 *
 *   npx tsx tools/feature-stress-test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../src/main/session.js';
import {
  addStage,
  createRectangularRoom,
  openPlanModel,
  resetPlanModel,
} from '../src/main/plan-model.js';
import {
  emptyInventory,
  mergeItems,
  updateInventoryItem,
  locateInventoryItem,
  type Inventory,
} from '../src/inventory/model.js';
import { chooseSymbol, mapSymbols } from '../src/inventory/match.js';
import { matchInsertItem, INSERT_TREE, flattenInsertLeaves } from '../src/inventory/insert-catalog.js';
import { exportInventoryPack, importInventoryPack } from '../src/inventory/share.js';
import { inventoryPath, saveInventory } from '../src/inventory/store.js';
import { placeGear, placeTracedIcon } from '../src/format/place.js';
import { indexDocument, measureNode, duplicateNode, moveNode, deleteNode } from '../src/format/edit.js';
import { verifyWritable } from '../src/format/write.js';
import { walk } from '../src/format/rv.js';
import { UNITS_PER_FOOT, UNITS_PER_INCH } from '../src/format/rv.js';
import { fixturePlanBuffer } from './test-fixture.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    passed++;
    console.log(`  pass  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
  return ok;
}

const F = UNITS_PER_FOOT;
const IN = UNITS_PER_INCH;
const root = mkdtempSync(join(tmpdir(), 'groundplan-feature-stress-'));

function stripPhotosForList(inventory: Inventory) {
  return inventory.items.map((item) => {
    const { photoDataUrl, ...rest } = item;
    return photoDataUrl ? { ...rest, hasPhoto: true as const } : rest;
  });
}

async function main(): Promise<void> {
  console.log('Feature stress — Card Party / inventory / stage / Insert arc\n');

  // --- 1. Tiered stage + stairs naming --------------------------------------
  {
    console.log('1. Tiered stage + stairs');
    resetPlanModel();
    const tmp = join(root, 'stage.rv4');
    writeFileSync(tmp, fixturePlanBuffer({ walls: false }));
    const session = new Session(tmp, readFileSync(tmp));
    await openPlanModel(tmp, session.loaded.document, 'imperial');
    const room = createRectangularRoom(session, 80 * F, 60 * F, 'imperial');
    check('room created', room.ok, room.reason);
    session.refresh();
    const built = addStage(session, 0, 0, 42 * F, 8 * F, 32 * IN, {
      back: { depth: 8 * F, height: 24 * IN },
      stairs: ['left', 'right'],
    });
    check('stage builds', built.ok, built.reason);
    check('stage + stairs created', (built.created?.length ?? 0) >= 2, String(built.created?.length));
    session.refresh();
    const names = [...walk(session.loaded.document)].map((n) => n.labels[0] ?? '');
    check(
      'stairs named for the stage',
      names.some((n) => /^Stairs · Tiered stage/i.test(n)),
      names.filter((n) => /stair/i.test(n)).join(', '),
    );
    const stageId = built.created![0]!;
    const stairsId = built.created![1]!;
    const stageBefore = session.index.byId.get(stageId)!;
    const stairsBefore = session.index.byId.get(stairsId)!;
    const sx = stageBefore.points[0]?.x ?? 0;
    const stairX = stairsBefore.points[0]?.x ?? 0;
    moveNode(session.loaded.document, stageBefore, 5 * F, 0);
    moveNode(session.loaded.document, stairsBefore, 5 * F, 0);
    session.refresh();
    const stageAfter = session.index.byId.get(stageId)!;
    const stairsAfter = session.index.byId.get(stairsId)!;
    check(
      'stage and stairs can move the same delta',
      Math.abs((stageAfter.points[0]?.x ?? 0) - (sx + 5 * F)) < 1 &&
        Math.abs((stairsAfter.points[0]?.x ?? 0) - (stairX + 5 * F)) < 1,
    );
    const measured = measureNode(stageAfter);
    check(
      'stage footprint stays ~42×16 (no stairs in measure)',
      Math.abs(measured.width - 42 * F) < F && Math.abs(measured.height - 16 * F) < F,
      `${measured.width / F}x${measured.height / F} ft`,
    );
    check('writable after stage', verifyWritable(session.loaded.document).ok);
  }

  // --- 2. Repeat across -----------------------------------------------------
  {
    console.log('\n2. Repeat across');
    const tmp = join(root, 'repeat.rv4');
    writeFileSync(tmp, fixturePlanBuffer());
    const session = new Session(tmp, fixturePlanBuffer());
    const placed = placeGear(session.loaded.document, session.index, "6' x 8' Stage Deck", 0, 0, {
      width: 6 * F,
      height: 8 * F,
    });
    check('deck placed for repeat', placed.ok);
    session.refresh();
    let node = session.index.byId.get(placed.created![0]!)!;
    const spacing = measureNode(node).width;
    check('deck width is 6ft', Math.abs(spacing - 6 * F) < 1, String(spacing / F));
    const created = [node.id];
    for (let i = 1; i < 7; i++) {
      const copy = duplicateNode(session.loaded.document, session.index, node, spacing, 0);
      check(`repeat copy ${i}`, copy.ok, copy.reason);
      session.index = indexDocument(session.loaded.document);
      node = session.index.byId.get(copy.created![0]!)!;
      created.push(node.id);
    }
    check('seven decks after ×7', created.length === 7);
    const xs = created.map((id) => session.index.byId.get(id)!.points[0]!.x).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    check(
      'copies spaced by deck width',
      gaps.every((g) => Math.abs(g - 6 * F) < 1),
      gaps.map((g) => (g / F).toFixed(2)).join(', '),
    );
    check('writable after repeat', verifyWritable(session.loaded.document).ok);
  }

  // --- 3. Circular deck place -----------------------------------------------
  {
    console.log('\n3. Circular deck');
    const tmp = join(root, 'circ.rv4');
    writeFileSync(tmp, fixturePlanBuffer());
    const session = new Session(tmp, fixturePlanBuffer());
    const placed = placeGear(session.loaded.document, session.index, 'Circular deck', 0, 0, {
      width: 8 * F,
      height: 8 * F,
    });
    check('circular deck places', placed.ok, placed.reason);
    check('circular uses synthesize path', placed.method === 'synthesized');
    session.refresh();
    const node = session.index.byId.get(placed.created![0]!)!;
    const size = measureNode(node);
    check(
      'circular deck is roughly square footprint',
      Math.abs(size.width - size.height) < 2,
      `${size.width}x${size.height}`,
    );
    const geometry = node.children.find((c) => c.cls === 'RVGeometry');
    const poly = geometry?.children.find((c) => c.cls === 'RVSegmentPoly');
    const pts = poly?.fields.pointCount ?? poly?.points.length ?? 0;
    check('circular outline has many points', pts > 16, String(pts));
  }

  // --- 4. Insert matching ---------------------------------------------------
  {
    console.log('\n4. Insert catalog');
    const items = [
      { id: '1', name: 'PAR 64', category: 'lighting' as const },
      { id: '2', name: 'USB adapter cable', category: 'cable' as const },
      { id: '3', name: 'Barco HDX-W20', category: 'projector' as const },
      { id: '4', name: '6x8 Stage Deck', category: 'riser' as const },
    ];
    const leaves = flattenInsertLeaves(INSERT_TREE);
    const par = leaves.find((l) => /par/i.test(l.label) || l.keywords.some((k) => k.toLowerCase() === 'par'));
    if (par) {
      const hit = matchInsertItem(par, items);
      check('PAR matches lighting, not adapter', hit?.name === 'PAR 64', hit?.name);
    } else {
      check('PAR leaf exists in Insert tree', false);
    }
    const barco = leaves.find((l) => /barco|projector/i.test(l.label) && l.stockName);
    if (barco) {
      const empty = matchInsertItem(barco, [{ id: 'x', name: 'Random Speaker', category: 'speaker' }]);
      check('stockName leaf does not steal on category alone', empty === null);
    }
    check('Insert tree has leaves', leaves.length >= 20, String(leaves.length));
  }

  // --- 5. Slim photo list + pack photo round-trip ---------------------------
  {
    console.log('\n5. Photos / slim list / packs');
    const shop = join(root, 'shop');
    mkdirSync(shop, { recursive: true });
    const file = inventoryPath(shop);
    const inventory: Inventory = emptyInventory();
    mergeItems(inventory, [
      {
        name: 'Chiavari Chair',
        width: 180,
        height: 180,
        sizeSource: 'user',
        photoDataUrl: 'data:image/png;base64,' + 'a'.repeat(120),
      },
      {
        name: 'LCD Projector',
        width: 200,
        height: 140,
        sizeSource: 'symbol',
        symbolPath: join(root, 'missing-symbols.rv4'),
        tracedIcon: {
          width: 200,
          height: 140,
          paths: [{ points: [0, 0, 200, 0, 200, 140, 0, 140], closed: true }],
        },
      },
    ]);
    await saveInventory(file, inventory);
    const listed = stripPhotosForList(inventory);
    check(
      'list strips photoDataUrl',
      listed.every((i) => !('photoDataUrl' in i && (i as { photoDataUrl?: string }).photoDataUrl)),
    );
    check('list flags hasPhoto', listed.some((i) => (i as { hasPhoto?: boolean }).hasPhoto));
    const packDir = join(root, 'usb-pack');
    const before = inventory.items.map((i) => i.symbolPath);
    const exported = await exportInventoryPack(file, inventory, packDir);
    check('pack export ok', exported.ok, exported.ok ? '' : exported.reason);
    check(
      'export does not mutate live symbolPath',
      inventory.items.every((item, i) => item.symbolPath === before[i]),
    );
    const shopB = join(root, 'shop-b');
    mkdirSync(shopB, { recursive: true });
    const fileB = inventoryPath(shopB);
    const invB = emptyInventory();
    await saveInventory(fileB, invB);
    const imported = await importInventoryPack(packDir, fileB, invB);
    check('pack import ok', imported.ok);
    check('photo survived pack trip', !!invB.items.find((i) => /chiavari/i.test(i.name))?.photoDataUrl);
    check(
      'tracedIcon survived pack trip',
      !!invB.items.find((i) => /projector/i.test(i.name))?.tracedIcon,
    );
  }

  // --- 6. Rename + place cascade --------------------------------------------
  {
    console.log('\n6. Place cascade / rename');
    const inventory: Inventory = emptyInventory();
    mergeItems(inventory, [
      {
        name: 'LCD Projector',
        width: 200,
        height: 140,
        sizeSource: 'symbol',
        symbolPath: join(root, 'does-not-exist.rv4'),
        tracedIcon: {
          width: 200,
          height: 140,
          paths: [{ points: [-100, -70, 100, -70, 100, 70, -100, 70], closed: true }],
        },
      },
    ]);
    updateInventoryItem(inventory, inventory.items[0]!.id, { name: 'Panasonic stand-in' });
    check('rename kept symbolName', inventory.items[0]!.symbolName === 'LCD Projector');
    check('missing symbol file', !existsSync(inventory.items[0]!.symbolPath!));

    const tmp = join(root, 'place.rv4');
    writeFileSync(tmp, fixturePlanBuffer());
    const session = new Session(tmp, fixturePlanBuffer());
    const item = inventory.items[0]!;
    const placed = placeTracedIcon(
      session.loaded.document,
      session.index,
      item.name,
      10,
      10,
      item.tracedIcon!,
    );
    check('places traced silhouette when symbol missing', placed.ok, placed.reason);
    check('writable after traced place', verifyWritable(session.loaded.document).ok);

    const choice = chooseSymbol(
      {
        ...emptyInventory(),
        items: [
          {
            id: 'p',
            name: 'LCD Projector',
            width: 200,
            height: 140,
            sizeSource: 'symbol',
            category: 'projector',
            symbolPath: join(root, 'x.rv4'),
            symbolName: 'LCD Projector Outline',
            timesSeen: 3,
            peakQuantity: 1,
            addedAt: new Date().toISOString(),
          },
        ],
      },
      'Panasonic PT-RZ21KU Laser Projector',
    );
    check('chooseSymbol for branded projector', choice?.symbolName === 'LCD Projector Outline', choice?.symbolName);
  }

  // --- 7. User map survives harvest merge -----------------------------------
  {
    console.log('\n7. Map / harvest safety');
    const inventory: Inventory = emptyInventory();
    inventory.items.push({
      id: 'u1',
      name: 'QSC K12.2',
      width: 200,
      height: 200,
      sizeSource: 'user',
      category: 'speaker',
      symbolPath: join(root, 'user.rv4'),
      symbolName: 'Speaker Box',
      mappedBy: 'user',
      mapReason: 'hand',
      timesSeen: 1,
      peakQuantity: 1,
      addedAt: new Date().toISOString(),
    });
    writeFileSync(join(root, 'user.rv4'), 'x');
    writeFileSync(join(root, 'harvest.rv4'), 'y');
    mergeItems(
      inventory,
      [
        {
          name: 'QSC K12.2',
          symbolPath: join(root, 'harvest.rv4'),
          symbolName: 'Wrong',
          width: 210,
          height: 210,
          sizeSource: 'symbol',
        },
      ],
      new Date(),
      { type: 'plan', sourcePath: join(root, 'harvest.rv4') },
    );
    check('user map survives harvest merge', inventory.items[0]!.symbolPath?.endsWith('user.rv4') === true);
    mapSymbols(inventory);
    check('mapSymbols leaves user map alone', inventory.items[0]!.mappedBy === 'user');
    const ambig = emptyInventory();
    ambig.items.push(
      { ...inventory.items[0]!, id: 'dup', name: 'A' },
      { ...inventory.items[0]!, id: 'dup', name: 'B' },
    );
    check('locate refuses ambiguous ids', locateInventoryItem(ambig, 'dup') === null);
  }

  // --- 8. Stage cleanup -----------------------------------------------------
  {
    console.log('\n8. Stage cleanup');
    resetPlanModel();
    const tmp = join(root, 'del.rv4');
    writeFileSync(tmp, fixturePlanBuffer({ walls: false }));
    const session = new Session(tmp, readFileSync(tmp));
    await openPlanModel(tmp, session.loaded.document, 'imperial');
    const built = addStage(session, 0, 0, 16 * F, 8 * F, 24 * IN, { stairs: ['front'] });
    check('simple stage with stairs', (built.created?.length ?? 0) >= 2);
    session.refresh();
    for (const id of built.created ?? []) {
      const node = session.index.byId.get(id);
      if (!node) continue;
      check(`delete ${id}`, deleteNode(session.loaded.document, session.index, node).ok);
      session.index = indexDocument(session.loaded.document);
    }
    check('writable after deletes', verifyWritable(session.loaded.document).ok);
  }

  // --- 9. Object-link sidecar round-trip ------------------------------------
  {
    console.log('\n9. Object link persistence');
    const {
      applyObjectLinkFile,
      objectLinksFromMap,
      saveObjectLinks,
      loadObjectLinks,
    } = await import('../src/main/object-links.js');
    const plan = join(root, 'linked.rv4');
    writeFileSync(plan, 'x');
    const map = new Map<number, number[]>([
      [10, [20]],
      [20, [10]],
    ]);
    await saveObjectLinks(plan, objectLinksFromMap(map));
    const loaded = await loadObjectLinks(plan);
    const restored = new Map<number, number[]>();
    applyObjectLinkFile(loaded.file, restored);
    check('link sidecar restores both directions', restored.get(10)?.includes(20) === true && restored.get(20)?.includes(10) === true);
    check('link sidecar has one pair', loaded.file.pairs.length === 1);

    const grouped = new Map<number, number[]>([
      [1, [2, 3]],
      [2, [1]],
      [3, [1]],
    ]);
    const kinds = new Map([
      ['1:2', 'group' as const],
      ['1:3', 'group' as const],
    ]);
    await saveObjectLinks(plan, objectLinksFromMap(grouped, kinds));
    const groupedLoaded = await loadObjectLinks(plan);
    check('group kind round-trips', groupedLoaded.file.pairs.every((p) => p.kind === 'group'));
    check('group sidecar keeps both pairs', groupedLoaded.file.pairs.length === 2);
  }

  rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
