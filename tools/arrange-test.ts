import { readFileSync } from 'node:fs';

import { arrangeMoves, type ArrangeItem } from '../src/format/arrange.js';
import { flipNode } from '../src/format/edit.js';
import { loadBuffer } from '../src/format/index.js';
import { Session } from '../src/main/session.js';
import { roundTrip } from '../src/format/write.js';

const PLAN =
  process.argv[2] ?? '/Volumes/Prince/Roomviewer/Data/ADDISON TRAINING ROOM bootcamp v1.rv4';

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

const items: ArrangeItem[] = [
  { id: 1, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
  { id: 2, bounds: { minX: 30, minY: 20, maxX: 50, maxY: 30 } },
  { id: 3, bounds: { minX: 100, minY: 40, maxX: 110, maxY: 50 } },
];

const left = arrangeMoves(items, 'align-left');
check('align-left keeps the outside item fixed', left[0]?.dx === 0);
check('align-left moves every other left edge to the selection edge', left[1]?.dx === -30 && left[2]?.dx === -100);

const middle = arrangeMoves(items, 'align-middle');
check('align-middle uses the centre of the whole selection', middle[0]?.dy === 20 && middle[1]?.dy === 0 && middle[2]?.dy === -20);

const across = arrangeMoves(items, 'distribute-horizontal');
check('horizontal distribution keeps both outside items fixed', across[0]?.dx === 0 && across[2]?.dx === 0);
check('horizontal distribution gives unequal-width items equal clear space', across[1]?.dx === 15);
check('distribution requires three items', arrangeMoves(items.slice(0, 2), 'distribute-horizontal').length === 0);

const original = readFileSync(PLAN);
const session = new Session(PLAN, original);
if (session.editable) {
  const target = [...session.index.byId.values()].find(
    (node) => node.cls === 'RVShape' && node.children.length > 0 && !session.index.shared.has(node),
  );
  check('found an item that can be mirrored', !!target);
  if (target) {
    const before = session.scene.primitives
      .filter((primitive) => primitive.selectId === target.id)
      .flatMap((primitive) => primitive.pts);
    session.checkpoint();
    const result = flipNode(session.loaded.document, target, 'horizontal');
    session.refresh();
    const after = session.scene.primitives
      .filter((primitive) => primitive.selectId === target.id)
      .flatMap((primitive) => primitive.pts);
    check('horizontal flip changes the outline', result.ok && JSON.stringify(before) !== JSON.stringify(after));

    const reopened = loadBuffer(session.file(), PLAN);
    check('a mirrored plan reparses without warnings', reopened.document.warnings.length === 0);
    check('a mirrored plan remains byte-stable', roundTrip(reopened.document).identical);
  }
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
